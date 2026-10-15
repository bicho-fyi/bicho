import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext, reset } from "cloudflare:test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../../src/index.ts";
import { prepareEvent, persistEvent, type Env as WorkerEnv, type Project } from "../../src/core.ts";
import { HttpError, type JsonObject } from "../../src/http.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] }
    interface GlobalProps { mainModule: typeof import("../../src/index.ts") }
  }
}

const auth = { Authorization: "Bearer admin-test-token" };
const call = async (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://bicho.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};
const read = (path: string) => call(path, { headers: auth });
const event = (id: string, fields = {}) => ({ event_id: id.repeat(32), message: "runtime bug", timestamp: "2026-10-01T10:00:00Z", ...fields });
const send = async (value: JsonObject, projectId = "1") => {
  try {
    const project = await env.DB.prepare("SELECT id, public_key, secret_hash, hourly_limit FROM projects WHERE id=?").bind(projectId).first<Project>();
    const prepared = await prepareEvent(value, {});
    await persistEvent(env, project!, prepared);
    return Response.json({ id: prepared.id });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return Response.json({ error: error.message }, { status: error.status, headers: error.headers });
  }
};
const ingest = (key = "public") => call("/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", "X-Bicho-Key": key }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityNumber: 17, body: { stringValue: "ingest trigger" } }] }] }] }) });

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO projects (id,name,public_key) VALUES ('1','test','public')"),
    env.DB.prepare("INSERT INTO projects (id,name,public_key) VALUES ('2','other','other')"),
  ]);
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await reset(); });

test("real D1/R2 preserves grouped gzip captures across retries, project boundaries and status history", async () => {
  const payload = event("a");
  for (const value of [payload, payload, event("b")]) expect((await send(value)).status).toBe(200);
  const list = await (await read("/api/1/issues")).json<{ issues: { id: string; event_count: number }[] }>();
  expect(list.issues).toHaveLength(1);
  expect(list.issues[0]!.event_count).toBe(2);
  const id = list.issues[0]!.id;
  const row = await env.DB.prepare("SELECT payload_key FROM events WHERE project_id='1' AND id=?").bind(payload.event_id).first<{ payload_key: string }>();
  const object = (await env.PAYLOADS.get(row!.payload_key))!;
  const original = new Uint8Array(await object.arrayBuffer());
  expect([...original.slice(0, 2)]).toEqual([31, 139]);
  expect(JSON.parse(await new Response(new Blob([original]).stream().pipeThrough(new DecompressionStream("gzip"))).text())).toEqual(payload);
  expect((await read(`/api/2/events/${payload.event_id}`)).status).toBe(404);
  expect((await read(`/api/2/issues/${id}`)).status).toBe(404);
  for (const status of ["resolved", "resolved", "ignored", "muted", "unresolved"]) {
    expect((await call(`/api/1/issues/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ status }) })).status).toBe(200);
    expect(await (await read(`/api/1/events/${payload.event_id}`)).json()).toEqual(payload);
  }
  const history = await (await read(`/api/1/issues/${id}/history`)).json<{ history: unknown[] }>();
  expect(history.history).toHaveLength(4);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM events").first("n")).toBe(2);
  expect((await env.PAYLOADS.list()).objects).toHaveLength(2);
  expect(new Uint8Array(await (await env.PAYLOADS.get(row!.payload_key))!.arrayBuffer())).toEqual(original);
  expect((await call(`/api/1/events/${payload.event_id}`, { method: "DELETE", headers: auth })).status).toBe(405);
});

test("admin and OTLP authorization stay separate and absent admin configuration fails closed", async () => {
  expect((await ingest("wrong")).status).toBe(403);
  expect((await ingest()).status).toBe(200);
  expect((await send(event("a"))).status).toBe(200);
  for (const path of ["/api/projects", "/api/1/issues", "/api/1/events", "/api/1/stats", "/api/1/processing", "/mcp"]) {
    for (const headers of [new Headers(), new Headers({ Authorization: "Bearer public" })]) {
      expect((await call(path, { headers, ...(path === "/mcp" ? { method: "POST", body: "{}" } : {}) })).status).toBe(401);
    }
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://bicho.test${path}`, { headers: auth, ...(path === "/mcp" ? { method: "POST", body: "{}" } : {}) }), { ...env, BICHO_ADMIN_TOKEN: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
  }
  const id = await env.DB.prepare("SELECT id FROM issues").first<string>("id");
  expect((await call(`/api/1/issues/${id}`, { method: "PATCH", headers: { Authorization: "Bearer public" }, body: '{"status":"resolved"}' })).status).toBe(401);
  expect(await env.DB.prepare("SELECT status FROM issues").first("status")).toBe("unresolved");
});

test("real D1 batch rollback and quota triggers prevent partial indexed events under contention", async () => {
  await env.DB.prepare("UPDATE projects SET hourly_limit=2 WHERE id='1'").run();
  const responses = await Promise.all(["a", "b", "c", "d", "e"].map(id => send(event(id))));
  expect(responses.map(r => r.status).sort()).toEqual([200, 200, 429, 429, 429]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM events").first("n")).toBe(2);
  expect(await env.DB.prepare("SELECT event_count FROM issues").first("event_count")).toBe(2);
  expect((await env.PAYLOADS.list()).objects).toHaveLength(2);
  await expect(env.DB.batch([
    env.DB.prepare("UPDATE projects SET name='must-roll-back' WHERE id='1'"),
    env.DB.prepare("INSERT INTO events (project_id,id,issue_id,timestamp,received_at,level,payload_key) SELECT '1',?,id,?,?, 'error','not-written' FROM issues WHERE project_id='1'").bind("f".repeat(32), new Date().toISOString(), new Date().toISOString()),
  ])).rejects.toThrow(/ingest_quota_exceeded/);
  expect(await env.DB.prepare("SELECT name FROM projects WHERE id='1'").first("name")).toBe("test");
  const existing = await env.DB.prepare("SELECT id FROM events LIMIT 1").first<string>("id");
  expect((await send({ ...event("a"), event_id: existing! })).status).toBe(200);
});

test("cursor snapshots exclude new backdated events and deterministic stats stay project-scoped", async () => {
  for (const id of ["a", "b"]) expect((await send(event(id, { tags: { region: "eu" } }))).status).toBe(200);
  expect((await send(event("a"), "2")).status).toBe(200);
  type Page = { events: { id: string }[]; next_cursor: string | null; has_more: boolean };
  const first = await (await read("/api/1/events?limit=1&tag.region=eu")).json<Page>();
  expect(first.events).toHaveLength(1);
  expect(first.next_cursor).toBeTruthy();
  expect(first.has_more).toBe(true);
  expect((await send(event("c", { tags: { region: "eu" } }))).status).toBe(200);
  const second = await (await read(`/api/1/events?limit=1&tag.region=eu&cursor=${first.next_cursor}`)).json<Page>();
  expect(second.events).toHaveLength(1);
  expect(second.events[0]!.id).not.toBe(first.events[0]!.id);
  expect(second.next_cursor).toBeNull();
  expect(second.has_more).toBe(false);
  expect((await read(`/api/2/events?tag.region=eu&cursor=${first.next_cursor}`)).status).toBe(400);
  expect((await read(`/api/1/events?tag.region=us&cursor=${first.next_cursor}`)).status).toBe(400);
  const stats = await (await read("/api/1/stats?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z")).json<{ total_count: number; unique_issues: number; buckets: unknown[] }>();
  expect(stats.total_count).toBe(3);
  expect(stats.unique_issues).toBe(1);
  expect(stats.buckets).toEqual([{ bucket: "2026-10-01T10:00:00.000Z", count: 3 }]);
});

test("official MCP client investigates and changes issue status through authenticated API inside workerd", async () => {
  expect((await send(event("a", { release: "v1" }))).status).toBe(200);
  const paths: string[] = [];
  const fetch = worker.fetch;
  vi.spyOn(worker, "fetch").mockImplementation((...args) => { paths.push(new URL(args[0].url).pathname); return fetch(...args); });
  const client = new Client({ name: "runtime-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://bicho.test/mcp"), {
      requestInit: { headers: auth },
      fetch: (input, init) => exports.default.fetch(new Request(input, init)),
    }));
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["create_project", "get_event", "get_issue", "get_issue_history", "get_processing_health", "get_stats", "list_projects", "list_releases", "search_events", "search_issues", "update_issue_status"]);
    expect(tools.filter(tool => !["create_project", "update_issue_status"].includes(tool.name)).every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.find(tool => tool.name === "update_issue_status")?.annotations?.readOnlyHint).toBe(false);
    const created = await client.callTool({ name: "create_project", arguments: { name: "runtime project", secret: true } });
    expect(created.isError).not.toBe(true);
    const registration = created.structuredContent as { project: { id: string }; otlp: { headers: Record<string, string> } };
    expect(paths.filter(path => path === "/api/projects")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT name FROM projects WHERE id=?").bind(registration.project.id).first("name")).toBe("runtime project");
    expect(registration.otlp.headers["X-Bicho-Secret"]).toMatch(/^[a-f0-9]{64}$/);
    expect((await read(`/api/${registration.project.id}/issues`)).status).toBe(200);
    expect((await call("/api/projects", { method: "DELETE", headers: auth })).status).toBe(405);
    expect((await call("/api/projects", { method: "POST", headers: { "X-Bicho-Key": "public" }, body: '{"name":"denied"}' })).status).toBe(401);
    const result = await client.callTool({ name: "get_event", arguments: { project_id: "1", id: "a".repeat(32) } });
    expect(result.isError).not.toBe(true);
    expect(paths).toContain(`/api/1/events/${"a".repeat(32)}`);
    expect((await client.callTool({ name: "get_event", arguments: { project_id: "2", id: "a".repeat(32) } })).isError).toBe(true);
    const id = await env.DB.prepare("SELECT id FROM issues WHERE project_id='1'").first<string>("id");
    for (const status of ["resolved", "ignored", "muted", "unresolved"]) {
      paths.length = 0;
      const updated = await client.callTool({ name: "update_issue_status", arguments: { project_id: "1", id, status } });
      expect(updated.isError).not.toBe(true);
      expect(paths).toContain(`/api/1/issues/${id}`);
      expect(await env.DB.prepare("SELECT status FROM issues WHERE project_id='1' AND id=?").bind(id).first("status")).toBe(status);
    }
    expect((await client.callTool({ name: "update_issue_status", arguments: { project_id: "2", id, status: "resolved" } })).isError).toBe(true);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM issue_history").first("n")).toBe(4);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM events").first("n")).toBe(1);
    expect(await (await read(`/api/1/events/${"a".repeat(32)}`)).json()).toEqual(event("a", { release: "v1" }));
    expect(await env.DB.prepare("SELECT status FROM issues").first("status")).toBe("unresolved");
  } finally { await client.close(); }
});

test("background ingestion and project-scoped map uploads enrich real R2 evidence without cron scans", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-13T00:00:00.000Z") });
  const debugId = "12345678-1234-4234-8234-123456789abc";
  const map = { version: 3, sources: ["original.ts"], names: [], mappings: "AAAA", sourcesContent: ["throw new Error('boom')"] };
  const payload = event("a", { stacktrace: { frames: [{ filename: "bundle.js", debug_id: debugId, lineno: 1, colno: 1 }] } });
  expect((await send(payload)).status).toBe(200);
  expect((await ingest()).status).toBe(200);
  const before = await env.DB.prepare("SELECT * FROM events WHERE project_id='1' AND id=?").bind(payload.event_id).first<{ payload_key: string; enrichment_checked_at: string; enrichment_status: string }>();
  expect(before!.enrichment_status).toBe("pending");
  expect(before!.enrichment_checked_at).toBeTruthy();
  const bytes = new Uint8Array(await (await env.PAYLOADS.get(before!.payload_key))!.arrayBuffer());
  const health = await env.DB.prepare("SELECT * FROM processing_state").first();
  await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);
  expect(await env.DB.prepare("SELECT * FROM processing_state").first()).toEqual(health);
  expect((await call(`/api/2/sourcemaps/${debugId}`, { method: "PUT", headers: auth, body: JSON.stringify(map) })).status).toBe(201);
  expect(await env.DB.prepare("SELECT enrichment_checked_at FROM events WHERE project_id='1' AND id=?").bind(payload.event_id).first("enrichment_checked_at")).toBe(before!.enrichment_checked_at);
  vi.advanceTimersByTime(60001);
  expect((await call(`/api/1/sourcemaps/${debugId}`, { method: "PUT", headers: auth, body: JSON.stringify(map) })).status).toBe(201);
  const evidence = await (await read(`/api/1/events/${payload.event_id}?include_enrichment=1`)).json<{ enrichment: { status: string; data: { frames: { mapped: { filename: string } }[] } } }>();
  expect(evidence.enrichment.status).toBe("succeeded");
  expect(evidence.enrichment.data.frames[0]!.mapped.filename).toBe("original.ts");
  expect(new Uint8Array(await (await env.PAYLOADS.get(before!.payload_key))!.arrayBuffer())).toEqual(bytes);
  expect(await (await read(`/api/1/events/${payload.event_id}`)).json()).toEqual(payload);
});

test("scheduled recovery resumes persisted source-map cursors with local D1 and R2", async () => {
  const frames = Array.from({ length: 101 }, (_, index) => ({ filename: "bundle.js", lineno: 1, colno: 1, debug_id: `${(index + 1).toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc` }));
  expect((await send(event("a", { stacktrace: { frames } }))).status).toBe(200);
  await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);
  expect(await env.DB.prepare("SELECT enrichment_cursor FROM events").first("enrichment_cursor")).toBe(100);
  const partial = await (await read(`/api/1/events/${"a".repeat(32)}?include_enrichment=1&fields=message`)).json<{ enrichment: { data: { processed_frames: number; truncation_reason: string } } }>();
  expect(partial.enrichment.data.processed_frames).toBe(100);
  expect(partial.enrichment.data.truncation_reason).toBe("lookup_budget");
  await env.DB.prepare("UPDATE processing_state SET last_started_at='2026-01-01T00:00:00.000Z'").run();
  await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);
  expect(await env.DB.prepare("SELECT enrichment_cursor FROM events").first("enrichment_cursor")).toBe(0);
  const final = await (await read(`/api/1/events/${"a".repeat(32)}?include_enrichment=1&fields=message&max_bytes=65536`)).json<{ enrichment: { data: { processed_frames: number; truncated: boolean } } }>();
  expect(final.enrichment.data.processed_frames).toBe(101);
  expect(final.enrichment.data.truncated).toBe(false);
}, 30000);
