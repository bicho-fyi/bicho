import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, deflateSync } from "node:zlib";
import { test } from "vitest";
import worker from "../src/index.ts";
import { bindings } from "./helpers.js";

const admin = { Authorization: "Bearer admin-test-token" };
const event = (id = "a", fields = {}) => ({ event_id: id.repeat(32), timestamp: 1792195200, exception: { values: [{ type: "TypeError", value: "broken", stacktrace: { frames: [{ filename: "app.js", function: "checkout", lineno: 12, colno: 4 }] } }] }, ...fields });
const envelope = (items, headers = {}) => Buffer.concat([Buffer.from(JSON.stringify(headers) + "\n"), ...items.map(([type, value]) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(JSON.stringify({ type, length: bytes.length }) + "\n"), bytes, Buffer.from("\n")]); })]);
const setup = () => {
  const b = bindings();
  const call = (path, init = {}) => worker.fetch(new Request(`https://bicho.test${path}`, init), b.env);
  const send = (body, path = "/api/1/envelope/?sentry_version=7&sentry_key=public", headers = {}) => call(path, { method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", ...headers }, body });
  return { ...b, call, send };
};

test("Sentry envelopes/store preserve sanitized evidence, grouping, retries and project isolation", async () => {
  const { sqlite, env, call, send } = setup();
  try {
    const value = event("a", { breadcrumbs: [{ message: "checkout", data: { password: "private" } }], contexts: { cart: { items: 2 } }, tags: { route: "/checkout" }, request: { headers: { Authorization: "Bearer private", "X-Sentry-Auth": "Sentry sentry_key=private" }, query_string: "sentry_key=private&sentry_secret=private" }, extra: { sentry_key: "private", sentry_secret: "private" } });
    const body = envelope([["attachment", Buffer.from([0, 10, 255, 10])], ["event", value], ["session", {}]]);
    for (const bytes of [body, body]) {
      const response = await send(bytes);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).discarded, { attachment: 1, session: 1 });
    }
    assert.equal((await send(JSON.stringify(event("b")), "/api/1/store/?sentry_version=7&sentry_key=public", { "Content-Type": "application/json" })).status, 200);
    assert.equal(sqlite.prepare("SELECT event_count FROM issues").get().event_count, 2);
    const stored = await (await call(`/api/1/events/${value.event_id}`, { headers: admin })).json();
    assert.deepEqual(stored.exception, value.exception);
    assert.deepEqual(stored.contexts, value.contexts);
    assert.equal(stored.breadcrumbs[0].data.password, "[Filtered]");
    assert.equal(stored.request.headers.Authorization, "[Filtered]");
    assert.equal(stored.request.headers["X-Sentry-Auth"], "[Filtered]");
    assert.equal(stored.extra.sentry_key, "[Filtered]");
    assert.equal(stored.extra.sentry_secret, "[Filtered]");
    assert.ok(!JSON.stringify(stored).includes("private"));
    assert.equal(stored.payload_format, "sentry.event");
    assert.equal((await call(`/api/2/events/${value.event_id}`, { headers: admin })).status, 404);
    assert.equal((await send(envelope([["event", value]]), "/api/2/envelope/?sentry_version=7&sentry_key=other")).status, 200);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events").get().n, 3);
    const issues = await (await call("/api/1/issues", { headers: admin })).json();
    assert.equal((await call(`/api/1/issues/${issues.issues[0].id}`, { method: "PATCH", headers: admin, body: '{"status":"resolved"}' })).status, 200);
    assert.equal((await send(envelope([["event", event("c")]]))).status, 200);
    assert.equal(sqlite.prepare("SELECT status FROM issues WHERE project_id='1'").get().status, "resolved");
    assert.equal((await call("/api/1/issues", { headers: { Authorization: "Bearer public" } })).status, 401);
    delete env.BICHO_ADMIN_TOKEN;
    assert.equal((await send(envelope([["event", event("d")]]))).status, 200);
  } finally { sqlite.close(); }
});

test("Sentry auth accepts query/header/self-auth envelopes and rejects credential or project disagreement", async () => {
  const { sqlite, send } = setup();
  try {
    const body = envelope([["event", event()]]);
    assert.equal((await send(body, "/api/1/envelope/", { "X-Sentry-Auth": "Sentry sentry_version=7, sentry_key=public, sentry_client=test/1" })).status, 200);
    assert.equal((await send(envelope([["event", event()]], { dsn: "https://public@bicho.test/1" }), "/api/1/envelope/")).status, 200);
    for (const [path, headers, input = body] of [
      ["/api/1/envelope/", {}],
      ["/api/1/envelope/", { Authorization: "Bearer admin-test-token" }],
      ["/api/2/envelope/?sentry_version=7&sentry_key=public", {}],
      ["/api/1/envelope/?sentry_version=7&sentry_key=other", {}],
      ["/api/1/envelope/?sentry_version=6&sentry_key=public", {}],
      ["/api/1/envelope/?sentry_version=7&sentry_key=public&sentry_key=public", {}],
      ["/api/1/envelope/?sentry_version=7&sentry_key=public", { "X-Sentry-Auth": "Sentry sentry_version=7,sentry_key=other" }],
      ["/api/1/envelope/", { "X-Sentry-Auth": "Sentry sentry_version=7,sentry_key=public,sentry_key=public" }],
      ["/api/1/envelope/?sentry_version=7&sentry_key=public", {}, envelope([], { dsn: "https://other@bicho.test/1" })],
      ["/api/1/envelope/", {}, envelope([], { dsn: "https://public@evil.test/1" })],
      ["/api/1/envelope/", {}, envelope([], { dsn: "https://public@bicho.test/2" })],
    ]) assert.equal((await send(input, path, headers)).status, 403, path);
    const secret = "backend-only";
    sqlite.prepare("UPDATE projects SET secret_hash=? WHERE id='1'").run(createHash("sha256").update(secret).digest("hex"));
    assert.equal((await send(body)).status, 403);
    assert.equal((await send(body, undefined, { "X-Bicho-Secret": secret })).status, 200);
    assert.equal((await send(body, `/api/1/envelope/?sentry_version=7&sentry_key=public&sentry_secret=${secret}`)).status, 200);
    assert.equal((await send(body, `/api/1/envelope/?sentry_version=7&sentry_key=public&sentry_secret=${secret}`, { "X-Bicho-Secret": "wrong" })).status, 403);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events").get().n, 1);
  } finally { sqlite.close(); }
});

test("Sentry framing, gzip/deflate, preflight and malformed batches are bounded before persistence", async () => {
  const { sqlite, send, call } = setup();
  try {
    const body = envelope([["event", event()]]);
    for (const [encoding, compressed] of [["gzip", gzipSync(body)], ["deflate", deflateSync(body)]]) assert.equal((await send(compressed, undefined, { "Content-Encoding": encoding })).status, 200);
    assert.equal((await send(Buffer.from('{}\n{"type":"event"}\n' + JSON.stringify(event("b"))))).status, 200);
    assert.equal((await send(envelope([], { dsn: "https://public@bicho.test/1" })) ).status, 200);
    for (const [input, status] of [
      [Buffer.from('{}\n{"type":"event","length":999}\n{}'), 400],
      [Buffer.from('{}\n{"type":"event","length":2}\n{}x'), 400],
      [Buffer.from('{}\n{"type":"event","length":-1}\n{}'), 400],
      [Buffer.from('{}\n{"type":"event"}'), 400],
      [envelope([["event", event("c")], ["event", { event_id: "bad" }]]), 400],
      [envelope([["event", event("c")], ["event", { timestamp: "bad" }]]), 400],
      [envelope([["event", { extra: JSON.parse('['.repeat(33) + '0' + ']'.repeat(33)) }]]), 400],
      [envelope([["event", { extra: Array(20001).fill(0) }]]), 400],
      [envelope([["event", { message: "x".repeat(1024 * 1024) }]]), 413],
      [Buffer.alloc(2 * 1024 * 1024 + 1, 120), 413],
      [gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 120)), 400],
      [envelope(Array.from({ length: 101 }, () => ["session", {}])), 413],
    ]) assert.equal((await send(input)).status, status, input.subarray(0, 70).toString());
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events").get().n, 2);
    assert.equal((await send(gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 120)), undefined, { "Content-Encoding": "gzip" })).status, 413);
    assert.equal((await send(Buffer.from([31, 139, 0]), undefined, { "Content-Encoding": "gzip" })).status, 400);
    assert.equal((await send(body, undefined, { "Content-Type": "image/png" })).status, 415);
    assert.equal((await send(body, undefined, { "Content-Encoding": "br" })).status, 415);
    const preflight = await call("/api/1/envelope/", { method: "OPTIONS", headers: { Origin: "https://app.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-sentry-auth" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /X-Sentry-Auth/);
    assert.equal((await call("/api/1/store/")).status, 405);
  } finally { sqlite.close(); }
});

test("Sentry quotas and storage failures report retryable whole failures without replaying accepted prefixes", async () => {
  const { sqlite, env, send } = setup();
  try {
    sqlite.prepare("UPDATE projects SET hourly_limit=1 WHERE id='1'").run();
    const partial = await send(envelope([["event", event("a")], ["event", event("b")]]));
    assert.equal(partial.status, 200);
    assert.match(partial.headers.get("X-Sentry-Rate-Limits"), /:error:project:quota_exceeded/);
    assert.deepEqual((await partial.json()).rejected, ["b".repeat(32)]);
    assert.equal((await send(envelope([["event", event("a")]]))).status, 200);
    const limited = await send(envelope([["event", event("b")]]));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) > 0);
    assert.match(limited.headers.get("X-Sentry-Rate-Limits"), /:error:/);
    sqlite.prepare("UPDATE projects SET hourly_limit=10 WHERE id='1'").run();
    const put = env.PAYLOADS.put;
    let count = 0;
    env.PAYLOADS.put = async (...args) => { if (++count > 1) throw new Error("unavailable"); return put(...args); };
    const storage = await send(envelope([["event", event("b")], ["event", event("c")]]));
    assert.equal(storage.status, 200);
    assert.deepEqual((await storage.json()).accepted, ["b".repeat(32)]);
    assert.equal((await send(envelope([["event", event("d")]]))).status, 503);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events").get().n, 2);
  } finally { sqlite.close(); }
});
