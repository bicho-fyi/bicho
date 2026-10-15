import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, reset } from "cloudflare:test";
import { beforeEach, afterEach, expect, test } from "vitest";
import { fromJson, toBinary, fromBinary, type JsonValue } from "@bufbuild/protobuf";
import { LogsRequest, LogsResponse, RpcStatus } from "../../src/vendor/otlp/schema.ts";
import worker from "../../src/index.ts";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("INSERT INTO projects (id,name,public_key) VALUES ('1','test','public')").run();
});
afterEach(async () => { await reset(); });

const payload: JsonValue = {
  resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "worker-backend" } }] }, scopeLogs: [{ logRecords: [{
    timeUnixNano: "1720000000123456789", severityNumber: 17, body: { stringValue: "runtime OTLP bug" }, attributes: [
      { key: "exception.type", value: { stringValue: "RuntimeError" } },
      { key: "exception.stacktrace", value: { stringValue: "RuntimeError: runtime OTLP bug\n    at checkout (app.js:20:3)\n    at async app.js:30:4" } },
      { key: "log.record.uid", value: { stringValue: "runtime-occurrence" } },
      { key: "password", value: { stringValue: "private-runtime-value" } },
      { key: "http.request.header.cookie", value: { arrayValue: { values: [{ stringValue: "private-cookie-value" }] } } },
      { key: "http.request.header.x-api-key", value: { stringValue: "private-api-key-value" } },
    ],
  }] }] }],
};
const call = async (body: BodyInit, contentType: string, key = "public", extra = {}) => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": contentType, "X-Bicho-Key": key, ...extra }, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};

test.each(["application/json", "application/x-protobuf"])("workerd %s uses real D1/R2 and matches wire response encoding", async contentType => {
  const binary = toBinary(LogsRequest, fromJson(LogsRequest, payload));
  const body = contentType === "application/json" ? JSON.stringify(payload) : binary;
  for (let i = 0; i < 2; i++) {
    const response = await call(body, contentType);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(contentType);
    if (contentType === "application/json") expect(await response.json()).toEqual({});
    else expect(fromBinary(LogsResponse, new Uint8Array(await response.arrayBuffer()))).not.toHaveProperty("partialSuccess");
  }
  expect(await env.DB.prepare("SELECT count(*) AS n FROM events").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT event_count FROM issues").first("event_count")).toBe(1);
  const row = await env.DB.prepare("SELECT id,payload_key FROM events").first<{ id: string; payload_key: string }>();
  const object = (await env.PAYLOADS.get(row!.payload_key))!;
  const raw = new Uint8Array(await object.arrayBuffer());
  expect([...raw.slice(0, 2)]).toEqual([31, 139]);
  const stored = JSON.parse(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
  expect(stored.payload_format).toBe("otlp.logs.v1");
  expect(stored.otlp.logRecord.timeUnixNano).toBe("1720000000123456789");
  expect(JSON.stringify(stored)).not.toContain("private-runtime-value");
  expect(JSON.stringify(stored)).not.toContain("private-cookie-value");
  expect(JSON.stringify(stored)).not.toContain("private-api-key-value");
  expect(stored.derived.frames[1]).toEqual({ filename: "app.js", function: "", lineno: 30, colno: 4 });
  expect(stored.otlp.logRecord.attributes.find((pair: { key: string }) => pair.key === "exception.stacktrace").value.stringValue).toContain("at async app.js:30:4");
  const read = await worker.fetch(new Request(`https://bicho.test/api/1/events/${row!.id}`, { headers: { Authorization: "Bearer admin-test-token" } }), env);
  expect(await read.json()).toEqual(stored);
  const denied = await call(body, contentType, "wrong");
  expect(denied.status).toBe(403);
  if (contentType === "application/json") expect(await denied.json()).toMatchObject({ code: 7 });
  else expect(fromBinary(RpcStatus, new Uint8Array(await denied.arrayBuffer()))).toMatchObject({ code: 7 });
});

test("workerd decompresses gzip protobuf and returns protobuf status for malformed input", async () => {
  const binary = toBinary(LogsRequest, fromJson(LogsRequest, payload));
  const gzip = new Uint8Array(await new Response(new Blob([binary]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  expect((await call(gzip, "application/x-protobuf", "public", { "Content-Encoding": "gzip" })).status).toBe(200);
  const bad = await call(new Uint8Array([255]), "application/x-protobuf");
  expect(bad.status).toBe(400);
  expect(fromBinary(RpcStatus, new Uint8Array(await bad.arrayBuffer()))).toMatchObject({ code: 3 });
});
