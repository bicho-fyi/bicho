import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, reset } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { BrowserClient, Scope, defaultStackParser, makeFetchTransport } from "@sentry/browser";
import worker from "../../src/index.ts";
import { hash } from "../../src/core.ts";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (id,name,public_key) VALUES ('1','test','public')"),
    env.DB.prepare("INSERT INTO projects (id,name,public_key) VALUES ('2','other','other')"),
  ]);
});
afterEach(async () => { await reset(); });
const auth = { Authorization: "Bearer admin-test-token" };
const call = async (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://bicho.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};
const body = (id = "a") => JSON.stringify({ event_id: id.repeat(32) }) + '\n{"type":"event"}\n' + JSON.stringify({ event_id: id.repeat(32), message: "runtime Sentry", extra: { password: "private" } });
const send = (input: BodyInit, project = "1", key = "public", headers = {}) => call(`/api/${project}/envelope/?sentry_version=7&sentry_key=${key}`, { method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", ...headers }, body: input });

test("real D1/R2 Sentry ingestion enforces auth, retry quotas, gzip, redaction and append-only status", async () => {
  const compressed = new Blob([body()]).stream().pipeThrough(new CompressionStream("gzip"));
  expect((await send(await new Response(compressed).arrayBuffer(), "1", "public", { "Content-Encoding": "gzip" })).status).toBe(200);
  expect((await send(body())).status).toBe(200);
  expect((await send(body(), "2", "public")).status).toBe(403);
  const evidence = await (await call(`/api/1/events/${"a".repeat(32)}`, { headers: auth })).json<{ extra: { password: string } }>();
  expect(evidence.extra.password).toBe("[Filtered]");
  expect((await call(`/api/2/events/${"a".repeat(32)}`, { headers: auth })).status).toBe(404);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM events").first("n")).toBe(1);
  await env.DB.prepare("UPDATE projects SET hourly_limit=1 WHERE id='1'").run();
  expect((await send(body())).status).toBe(200);
  const limited = await send(body("b"));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("X-Sentry-Rate-Limits")).toContain(":error:");
  const id = await env.DB.prepare("SELECT id FROM issues").first<string>("id");
  expect((await call(`/api/1/issues/${id}`, { method: "PATCH", headers: auth, body: '{"status":"resolved"}' })).status).toBe(200);
  expect((await send(body())).status).toBe(200);
  expect(await env.DB.prepare("SELECT status FROM issues").first("status")).toBe("resolved");
  expect((await call("/api/1/issues", { headers: { Authorization: "Bearer public" } })).status).toBe(401);
  await env.DB.prepare("UPDATE projects SET secret_hash=? WHERE id='1'").bind(await hash("backend-secret")).run();
  expect((await send(body())).status).toBe(403);
  expect((await send(body(), "1", "public", { "X-Bicho-Secret": "backend-secret" })).status).toBe(200);
  expect((await env.PAYLOADS.list()).objects).toHaveLength(1);
});

test("Sentry BrowserClient serializes and delivers actual envelopes inside workerd", async () => {
  const deliveries: string[] = [];
  const client = new BrowserClient({ dsn: "https://public@bicho.test/1", integrations: [], stackParser: defaultStackParser, sendClientReports: false,
    transport: options => makeFetchTransport(options, async (input: RequestInfo | URL, init?: RequestInit) => {
      deliveries.push(String(init?.body));
      return call(new URL(String(input)).pathname + new URL(String(input)).search, init);
    }),
  });
  try {
    client.init();
    const scope = new Scope();
    scope.setClient(client);
    scope.setContext("cart", { password: "private", items: 1 });
    scope.addBreadcrumb({ message: "runtime checkout" });
    const id = scope.captureException(new Error("workerd SDK failure"));
    expect(await client.flush(5000)).toBe(true);
    expect(deliveries).toHaveLength(1);
    const evidence = await (await call(`/api/1/events/${id}`, { headers: auth })).json<{ contexts: { cart: { password: string } }; breadcrumbs: { message: string }[]; exception: { values: { value: string }[] } }>();
    expect(evidence.contexts.cart.password).toBe("[Filtered]");
    expect(evidence.breadcrumbs[0]?.message).toBe("runtime checkout");
    expect(evidence.exception.values[0]?.value).toBe("workerd SDK failure");
    expect((await send(deliveries[0]!)).status).toBe(200);
    expect(await env.DB.prepare("SELECT event_count FROM issues").first("event_count")).toBe(1);
  } finally { await client.close(5000); }
});
