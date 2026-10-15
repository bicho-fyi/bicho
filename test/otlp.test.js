import { test, expect } from "vitest";
import { fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { LogsRequest, LogsResponse, RpcStatus } from "../src/vendor/otlp/schema.ts";
import { hash } from "../src/core.ts";
import worker from "../src/index.ts";
import { bindings } from "./helpers.js";

const attr = (key, stringValue) => ({ key, value: { stringValue } });
const request = records => ({ resourceLogs: [{ resource: { attributes: [attr("service.name", "checkout"), attr("service.version", "v1"), attr("deployment.environment.name", "production")] }, scopeLogs: [{ scope: { name: "test" }, logRecords: records }] }] });
const record = uid => ({ timeUnixNano: "1720000000123456789", severityNumber: 9, attributes: [attr("exception.type", "TypeError"), attr("exception.message", "broken"), attr("exception.stacktrace", "TypeError: broken\n    at main (app.js:10:2)"), attr("log.record.uid", uid)] });
const send = (env, input, headers = {}) => worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", "X-Bicho-Key": "public", ...headers }, body: JSON.stringify(input) }), env);
const evidence = async (env, sqlite) => {
  const { id } = sqlite.prepare("SELECT id FROM events LIMIT 1").get();
  return (await worker.fetch(new Request(`https://bicho.test/api/1/events/${id}`, { headers: { Authorization: "Bearer admin-test-token" } }), env)).json();
};

test.each(["application/json", "application/x-protobuf"])("OTLP %s supports batching, partial policy rejection and project isolation", async contentType => {
  const { env, sqlite } = bindings();
  try {
    const input = request([record("one"), { severityNumber: 9, body: { stringValue: "ordinary log" } }]);
    input.resourceLogs[0].scopeLogs.push({ logRecords: [{ severityNumber: 21, body: { stringValue: "plain fatal" } }] });
    input.resourceLogs.push({ scopeLogs: [{ logRecords: [record("two")] }] });
    const body = contentType === "application/json" ? JSON.stringify(input) : toBinary(LogsRequest, fromJson(LogsRequest, input));
    const response = await worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": contentType, "X-Bicho-Key": "public" }, body }), env);
    expect(response.status).toBe(200);
    const result = contentType === "application/json" ? await response.json() : fromBinary(LogsResponse, new Uint8Array(await response.arrayBuffer()));
    expect(String(result.partialSuccess.rejectedLogRecords)).toBe("1");
    expect(sqlite.prepare("SELECT count(*) AS n FROM events").get().n).toBe(3);
    expect((await send(env, request([record("one")]), { "X-Bicho-Key": "other" })).status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM events").get().n).toBe(4);
  } finally { sqlite.close(); }
});

test("typed credentials and nested structured bodies are filtered before storage and indexing", async () => {
  const { env, sqlite } = bindings();
  try {
    const r = { severityNumber: 17, body: { kvlistValue: { values: [attr("password", "body-private"), { key: "nested", value: { arrayValue: { values: [{ kvlistValue: { values: [attr("token", "nested-private")] } }] } } }] } }, attributes: [attr("api_key", "attr-private")] };
    const input = request([r]);
    input.resourceLogs[0].resource.attributes.push(attr("secret", "resource-private"));
    input.resourceLogs[0].scopeLogs[0].scope.attributes = [attr("authorization", "scope-private")];
    expect((await send(env, input)).status).toBe(200);
    const stored = JSON.stringify(await evidence(env, sqlite));
    for (const secret of ["body-private", "nested-private", "attr-private", "resource-private", "scope-private"]) expect(stored).not.toContain(secret);
    expect(stored).toContain("[Filtered]");
    expect(sqlite.prepare("SELECT message FROM events").get().message).not.toContain("[object Object]");
  } finally { sqlite.close(); }
});

test.each(["application/json", "application/x-protobuf"])("OTLP %s filters sensitive HTTP header attributes everywhere", async contentType => {
  const { env, sqlite } = bindings();
  try {
    const headers = ["http.request.header.cookie", "http.response.header.set-cookie", "http.request.header.authorization", "http.request.header.proxy-authorization", "http.request.header.x-api-key"];
    const sensitive = headers.map(key => ({ key, value: { arrayValue: { values: [{ stringValue: "private-header-value" }] } } }));
    const input = request([{ severityNumber: 17, body: { kvlistValue: { values: sensitive } }, attributes: [...sensitive, attr("http.request.header.content-type", "application/json"), attr("HTTP.RESPONSE.HEADER.X-API-KEY", "private-scalar-value")] }]);
    input.resourceLogs[0].resource.attributes.push(...sensitive);
    input.resourceLogs[0].scopeLogs[0].scope.attributes = sensitive;
    const body = contentType === "application/json" ? JSON.stringify(input) : toBinary(LogsRequest, fromJson(LogsRequest, input));
    const response = await worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": contentType, "X-Bicho-Key": "public" }, body }), env);
    expect(response.status).toBe(200);
    const stored = await evidence(env, sqlite);
    expect(JSON.stringify(stored)).not.toContain("private-header-value");
    expect(JSON.stringify(stored)).not.toContain("private-scalar-value");
    for (const attrs of [stored.otlp.resource.attributes, stored.otlp.scope.attributes, stored.otlp.logRecord.attributes, stored.otlp.logRecord.body.kvlistValue.values]) {
      for (const key of headers) expect(attrs.find(pair => pair.key === key).value).toEqual({ stringValue: "[Filtered]" });
    }
    expect(stored.tags["http.request.header.content-type"]).toBe("application/json");
    expect(JSON.stringify(sqlite.prepare("SELECT key,value FROM event_tags").all())).not.toContain("private-");
  } finally { sqlite.close(); }
});

test.each([
  { resourceLogs: "invalid" },
  request([{ severityNumber: "SEVERITY_NUMBER_ERROR" }]),
  request([{ severityNumber: 25 }]),
  request([{ timeUnixNano: "-1", severityNumber: 17 }]),
  request([{ severityNumber: 17, body: { stringValue: "a", intValue: "1" } }]),
  request([{ severityNumber: 17, attributes: [attr("log.record.uid", "")] }]),
])("invalid known OTLP fields reject the whole batch before persistence %#", async input => {
  const { env, sqlite } = bindings();
  try {
    const response = await send(env, input);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 3 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM events").get().n).toBe(0);
  } finally { sqlite.close(); }
});

test("correlation IDs are hex evidence, never occurrence dedup keys; observed timestamp is fallback", async () => {
  const { env, sqlite } = bindings();
  try {
    const r = { severityNumber: 17, timeUnixNano: "0", observedTimeUnixNano: "1720000000123456789", traceId: "0123456789abcdef0123456789abcdef", spanId: "not-a-span", body: { stringValue: "same error" } };
    for (let i = 0; i < 2; i++) expect((await send(env, request([r]))).status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM events").get().n).toBe(2);
    const stored = await evidence(env, sqlite);
    expect(stored.otlp.logRecord.traceId).toBe(r.traceId);
    expect(stored.otlp.logRecord).not.toHaveProperty("spanId");
    expect(sqlite.prepare("SELECT timestamp FROM events LIMIT 1").get().timestamp).toBe("2024-07-03T09:46:40.123Z");
  } finally { sqlite.close(); }
});

test("quota failures after an accepted prefix return partial success; retries still deduplicate at quota", async () => {
  const { env, sqlite } = bindings();
  try {
    sqlite.prepare("UPDATE projects SET hourly_limit=1 WHERE id='1'").run();
    const first = await send(env, request([record("one"), record("two")]));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ partialSuccess: { rejectedLogRecords: "1" } });
    expect((await send(env, request([record("one")]))).status).toBe(200);
    const limited = await send(env, request([record("two")]));
    expect(limited.status).toBe(429);
    expect(limited.headers.has("Retry-After")).toBe(true);
    expect(sqlite.prepare("SELECT count(*) AS n FROM events").get().n).toBe(1);
  } finally { sqlite.close(); }
});

test("storage outages return 503 before acceptance and partial success after acceptance", async () => {
  const { env, sqlite } = bindings();
  try {
    const put = env.PAYLOADS.put.bind(env.PAYLOADS);
    env.PAYLOADS.put = async () => { throw new Error("storage offline"); };
    expect((await send(env, request([record("first")]))).status).toBe(503);
    let n = 0;
    env.PAYLOADS.put = async (...args) => { if (++n > 1) throw new Error("storage offline"); return put(...args); };
    const response = await send(env, request([record("first"), record("second")]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ partialSuccess: { rejectedLogRecords: "1" } });
  } finally { sqlite.close(); }
});

test("ingest secrets and admin credentials never substitute for one another", async () => {
  const { env, sqlite } = bindings();
  try {
    sqlite.prepare("UPDATE projects SET secret_hash=? WHERE id='1'").run(await hash("test-backend-secret"));
    expect((await send(env, request([record("one")]))).status).toBe(403);
    expect((await send(env, request([record("one")]), { "X-Bicho-Secret": "test-backend-secret" })).status).toBe(200);
    expect((await send(env, request([record("two")]), { "X-Bicho-Key": "admin-test-token" })).status).toBe(403);
    const denied = await worker.fetch(new Request("https://bicho.test/api/1/issues", { headers: { "X-Bicho-Key": "public", "X-Bicho-Secret": "test-backend-secret" } }), env);
    expect(denied.status).toBe(401);
  } finally { sqlite.close(); }
});

test("batch limits, protobuf errors and browser preflight keep protocol responses", async () => {
  const { env, sqlite } = bindings();
  try {
    expect((await send(env, request(Array.from({ length: 101 }, (_, i) => record(String(i)))))).status).toBe(413);
    const bad = await worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": "application/x-protobuf", "X-Bicho-Key": "public" }, body: new Uint8Array([255]) }), env);
    expect(bad.status).toBe(400);
    expect(fromBinary(RpcStatus, new Uint8Array(await bad.arrayBuffer()))).toMatchObject({ code: 3 });
    const get = await worker.fetch(new Request("https://bicho.test/v1/logs"), env);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST, OPTIONS");
    const preflight = await worker.fetch(new Request("https://bicho.test/v1/logs", { method: "OPTIONS", headers: { Origin: "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-Bicho-Key,Content-Type" } }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("X-Bicho-Key");
  } finally { sqlite.close(); }
});


test.each([
  ["    at async app.js:43426:3", { filename: "app.js", function: "", lineno: 43426, colno: 3 }],
  ["    at async checkout (app.js:10:2)", { filename: "app.js", function: "checkout", lineno: 10, colno: 2 }],
  ["    at async https://example.test/app.js:10:2", { filename: "https://example.test/app.js", function: "", lineno: 10, colno: 2 }],
  ["    at /app/async app.js:10:2", { filename: "/app/async app.js", function: "", lineno: 10, colno: 2 }],
  ['Traceback (most recent call last):\n  File "outer.py", line 5, in outer\n  File "app.py", line 9, in checkout\nRuntimeError: broken', { filename: "app.py", lineno: 9, function: "checkout" }],
  ["app.rb:12:in `checkout'", { filename: "app.rb", lineno: 12, function: "checkout" }],
  ["#0 /app/index.php(15): checkout()", { filename: "/app/index.php", lineno: 15, function: "checkout()" }],
  ["   at src/main.rs:18:4", { filename: "src/main.rs", lineno: 18, colno: 4 }],
  ["unrecognized native stack", null],
])("natural stacks retain raw text and only derive recognized coordinates %#", async (stack, frame) => {
  const { env, sqlite } = bindings();
  try {
    const input = request([{ severityNumber: 17, attributes: [attr("exception.stacktrace", stack)] }]);
    expect((await send(env, input)).status).toBe(200);
    const stored = await evidence(env, sqlite);
    expect(stored.otlp.logRecord.attributes[0].value.stringValue).toBe(stack);
    if (frame) expect(stored.derived.frames[0]).toMatchObject(frame);
    else expect(stored.derived.frames).toEqual([]);
  } finally { sqlite.close(); }
});

test("redacting occurrence evidence does not collapse distinct occurrence IDs", async () => {
  const { env, sqlite } = bindings();
  try {
    for (const uid of ["Bearer first-value", "Bearer second-value", "Bearer first-value"]) expect((await send(env, request([record(uid)]))).status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM events").get().n).toBe(2);
    expect(JSON.stringify(await evidence(env, sqlite))).not.toContain("first-value");
  } finally { sqlite.close(); }
});

test("request budgets bound gzip expansion and nesting before writes", async () => {
  const { env, sqlite } = bindings();
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(request([{ severityNumber: 17, body: { stringValue: "x".repeat(2 * 1024 * 1024) } }])));
    const gzip = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const response = await worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "X-Bicho-Key": "public", "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: gzip }), env);
    expect(response.status).toBe(413);
    let value = { stringValue: "deep" };
    for (let i = 0; i < 40; i++) value = { arrayValue: { values: [value] } };
    expect((await send(env, request([{ severityNumber: 17, body: value }]))).status).toBe(400);
    expect(sqlite.prepare("SELECT count(*) AS n FROM events").get().n).toBe(0);
  } finally { sqlite.close(); }
});

test("OTLP exceptions use shared grouping, occurrence dedup and authenticated read evidence", async () => {
  const { env, sqlite } = bindings();
  try {
    for (const uid of ["order/error:1", "order/error:1", "order/error:2"]) {
      const response = await send(env, request([record(uid)]));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    }
    expect(sqlite.prepare("SELECT event_count FROM issues").get().event_count).toBe(2);
    const row = sqlite.prepare("SELECT * FROM events LIMIT 1").get();
    expect(row).toMatchObject({ type: "TypeError", message: "broken", environment: "production", release: "v1", level: "info", timestamp: "2024-07-03T09:46:40.123Z", enrichment_status: "not_applicable" });
    const response = await worker.fetch(new Request(`https://bicho.test/api/1/events/${row.id}`, { headers: { Authorization: "Bearer admin-test-token" } }), env);
    const stored = await response.json();
    expect(stored.payload_format).toBe("otlp.logs.v1");
    expect(stored.otlp.logRecord.timeUnixNano).toBe("1720000000123456789");
    expect(stored.otlp.scope.name).toBe("test");
    expect(stored.derived.frames).toEqual([{ filename: "app.js", function: "main", lineno: 10, colno: 2 }]);
  } finally { sqlite.close(); }
});
