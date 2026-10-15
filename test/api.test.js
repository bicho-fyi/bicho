import assert from "node:assert/strict";
import { bindings, capture, logs, log } from "./helpers.js";

import { test, afterEach, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("MCP client discovers investigation and status tools backed by the authenticated API", async () => {
  const { default: app } = await import("../src/index.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { sqlite, env } = bindings();
  const calls = [];
  const originalFetch = app.fetch;
  vi.spyOn(app, "fetch").mockImplementation((request, bindings) => {
    calls.push([request.method, new URL(request.url).pathname]);
    return originalFetch(request, bindings);
  });
  const send = async event => capture(env, event);
  const event = { event_id: "a".repeat(32), message: "MCP bug", release: "v1", environment: "production" };
  assert.equal((await send(event)).status, 200);
  assert.equal((await send({ ...event, event_id: "b".repeat(32) })).status, 200);
  const client = new Client({ name: "bicho-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://bicho.test/mcp"), {
    requestInit: { headers: { Authorization: "Bearer admin-test-token" } },
    fetch: (input, init) => app.fetch(new Request(input, init), env),
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["create_project", "get_event", "get_issue", "get_issue_history", "get_processing_health", "get_stats", "list_projects", "list_releases", "search_events", "search_issues", "update_issue_status"]);
    assert.ok(tools.filter(tool => !["create_project", "update_issue_status"].includes(tool.name)).every(tool => tool.annotations.readOnlyHint === true));
    assert.deepEqual(tools.find(tool => tool.name === "update_issue_status").annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(tools.find(tool => tool.name === "create_project").annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    calls.length = 0;
    const created = await client.callTool({ name: "create_project", arguments: { name: "MCP project", secret: true, hourly_limit: 25 } });
    assert.ok(!created.isError, created.content[0].text);
    const registration = JSON.parse(created.content[0].text);
    assert.equal(registration.project.name, "MCP project");
    assert.match(registration.project.id, /^[1-9]\d{0,18}$/);
    assert.equal(calls.filter(([method, path]) => method === "POST" && path === "/api/projects").length, 1);
    assert.equal(sqlite.prepare("SELECT name FROM projects WHERE id=?").get(registration.project.id).name, "MCP project");
    const search = await client.callTool({ name: "search_issues", arguments: { project_id: "1", q: "MCP", environment: "production" } });
    assert.ok(!search.isError);
    const issues = JSON.parse(search.content[0].text).issues;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].event_count, 2);
    const detail = await client.callTool({ name: "get_issue", arguments: { project_id: "1", id: issues[0].id } });
    assert.equal(JSON.parse(detail.content[0].text).events.length, 2);
    const payload = await client.callTool({ name: "get_event", arguments: { project_id: "1", id: event.event_id } });
    assert.deepEqual(JSON.parse(payload.content[0].text).event, event);
    assert.equal(JSON.parse(payload.content[0].text).provenance.untrusted, true);
    for (const [name, args, path] of [
      ["list_projects", {}, "/api/projects"],
      ["search_events", { project_id: "1", tags: { route: "/checkout" } }, "/api/1/events"],
      ["get_stats", { project_id: "1" }, "/api/1/stats"],
      ["get_issue_history", { project_id: "1", id: issues[0].id }, `/api/1/issues/${issues[0].id}/history`],
      ["get_processing_health", { project_id: "1" }, "/api/1/processing"],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, result.content[0].text);
      assert.ok(calls.some(([method, target]) => method === "GET" && target === path), `MCP bypassed read API: ${path}`);
    }
    const releases = await client.callTool({ name: "list_releases", arguments: { project_id: "1" } });
    assert.equal(JSON.parse(releases.content[0].text).releases[0].release, "v1");
    assert.equal(JSON.parse(releases.content[0].text).releases[0].event_count, 2);
    for (const path of ["/api/1/issues", `/api/1/issues/${issues[0].id}`, `/api/1/events/${event.event_id}`, "/api/1/releases"]) {
      assert.ok(calls.some(([method, target]) => method === "GET" && target === path), `MCP bypassed read API: ${path}`);
    }
    const wrongProject = await client.callTool({ name: "get_event", arguments: { project_id: "2", id: event.event_id } });
    assert.equal(wrongProject.isError, true);
    const invalid = await client.callTool({ name: "search_issues", arguments: { project_id: "../1" } });
    assert.equal(invalid.isError, true);
    const id = issues[0].id;
    for (const status of ["resolved", "ignored", "muted", "unresolved"]) {
      calls.length = 0;
      const result = await client.callTool({ name: "update_issue_status", arguments: { project_id: "1", id, status } });
      assert.ok(!result.isError, result.content[0].text);
      assert.ok(calls.some(([method, path]) => method === "PATCH" && path === `/api/1/issues/${id}`));
      assert.equal(JSON.parse(result.content[0].text).issue.status, status);
      const detail = await client.callTool({ name: "get_issue", arguments: { project_id: "1", id } });
      assert.equal(JSON.parse(detail.content[0].text).issue.status, status);
      assert.equal(JSON.parse(detail.content[0].text).events.length, 2);
    }
    await client.callTool({ name: "update_issue_status", arguments: { project_id: "1", id, status: "unresolved" } });
    const history = await client.callTool({ name: "get_issue_history", arguments: { project_id: "1", id } });
    assert.deepEqual(JSON.parse(history.content[0].text).history.map(row => row.to_status), ["unresolved", "muted", "ignored", "resolved"]);
    const preserved = await client.callTool({ name: "get_event", arguments: { project_id: "1", id: event.event_id } });
    assert.deepEqual(JSON.parse(preserved.content[0].text).event, event);
    for (const args of [{ project_id: "2", id, status: "resolved" }, { project_id: "1", id: "f".repeat(64), status: "resolved" }, { project_id: "1", id, status: "deleted" }, { project_id: "../1", id, status: "resolved" }, { project_id: "1", id: "bad", status: "resolved" }]) {
      assert.equal((await client.callTool({ name: "update_issue_status", arguments: args })).isError, true);
    }
    const mutationRpc = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "update_issue_status", arguments: { project_id: "1", id, status: "resolved" } } };
    const mutate = headers => app.fetch(new Request("https://bicho.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(mutationRpc) }), env);
    for (const headers of [{}, { Authorization: "Bearer public" }, { "X-Bicho-Key": "public" }]) assert.equal((await mutate(headers)).status, 401);
    delete env.BICHO_ADMIN_TOKEN;
    assert.equal((await mutate({ Authorization: "Bearer admin-test-token" })).status, 503);
    env.BICHO_ADMIN_TOKEN = "admin-test-token";
    assert.equal(sqlite.prepare("SELECT status FROM issues WHERE project_id='1' AND id=?").get(id).status, "unresolved");
    const releaseApi = await app.fetch(new Request("https://bicho.test/api/1/releases", { headers: { Authorization: "Bearer admin-test-token" } }), env);
    assert.equal(releaseApi.status, 200);
    assert.deepEqual(await releaseApi.json(), JSON.parse(releases.content[0].text));
  } finally {
    await client.close();
    sqlite.close();
  }
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const call = extra => app.fetch(new Request("https://bicho.test/mcp", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(rpc) }), env);
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ Authorization: "Bearer public" })).status, 401);
  assert.equal((await call({ Authorization: "Bearer admin-test-token", Origin: "https://evil.test" })).status, 403);
  assert.equal((await call({ Authorization: "Bearer admin-test-token", Origin: "null" })).status, 403);
  env.CORS_ORIGINS = "https://dashboard.test";
  const allowed = await call({ Authorization: "Bearer admin-test-token", Origin: "https://dashboard.test" });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://dashboard.test");
  assert.equal(allowed.headers.get("X-Content-Type-Options"), "nosniff");
  const oversized = await app.fetch(new Request("https://bicho.test/mcp", { method: "POST", headers: { ...headers, Authorization: "Bearer admin-test-token" }, body: "x".repeat(65537) }), env);
  assert.equal(oversized.status, 413);
  delete env.BICHO_ADMIN_TOKEN;
  assert.equal((await call({ Authorization: "Bearer admin-test-token" })).status, 503);
  env.BICHO_ADMIN_TOKEN = "admin-test-token";
  assert.equal((await app.fetch(new Request("https://bicho.test/mcp", { method: "GET", headers: { Authorization: "Bearer admin-test-token" } }), env)).status, 405);
});

test("admin auth stays separate from ingest keys and changes state without deleting data", async () => {
  const { default: app } = await import("../src/index.ts");
  const { sqlite, blobs, env } = bindings();
  env.BICHO_ADMIN_TOKEN = "admin-test-token";
  const call = (path, init = {}) => app.fetch(new Request(`https://bicho.test${path}`, init), env);
  const admin = { Authorization: "Bearer admin-test-token" };
  const payload = { event_id: "a".repeat(32), message: "milestone" };
  const send = event => capture(env, event);
  assert.equal((await send(payload)).status, 200);
  assert.equal((await send({ ...payload, event_id: "b".repeat(32) })).status, 200);
  for (const token of ["public", "read-token", "wrong", "admin-test-toke"]) {
    assert.equal((await call("/api/1/issues", { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  }
  const response = await call("/api/1/issues", { headers: admin });
  assert.equal(response.status, 200);
  const list = await response.json();
  assert.equal(list.issues.length, 1);
  assert.equal(list.issues[0].event_count, 2);
  assert.equal(list.issues[0].status, "unresolved");
  const id = list.issues[0].id;
  const change = (body, headers = admin, project = "1") => call(`/api/${project}/issues/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  assert.equal((await change({ status: "resolved" }, { Authorization: "Bearer public" })).status, 401);
  assert.equal((await change({ status: "resolved" }, { "X-Bicho-Key": "public" })).status, 401);
  assert.equal((await change({ status: "resolved" }, {})).status, 401);
  assert.equal((await change({ status: "deleted" })).status, 400);
  assert.equal((await change({ status: "resolved", delete: true })).status, 400);
  assert.equal((await change({ status: null })).status, 400);
  assert.equal((await call(`/api/1/issues/${id}`, { method: "PATCH", headers: admin, body: "{" })).status, 400);
  assert.equal((await call(`/api/1/issues/${id}`, { method: "PATCH", headers: admin, body: "x".repeat(1025) })).status, 413);
  assert.equal((await call("/api/1/issues?status=deleted", { headers: admin })).status, 400);
  const preflight = await call(`/api/1/issues/${id}`, { method: "OPTIONS", headers: { Origin: "https://dashboard.test", "Access-Control-Request-Method": "PATCH" } });
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /PATCH/);
  assert.equal((await change({ status: "resolved" }, admin, "2")).status, 404);
  for (const status of ["resolved", "ignored", "muted"]) {
    const patch = await change({ status });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).issue.status, status);
    assert.equal((await (await call("/api/1/issues", { headers: admin })).json()).issues.length, 0);
    assert.equal((await (await call(`/api/1/issues?status=${status}`, { headers: admin })).json()).issues[0].status, status);
    assert.equal((await (await call(`/api/1/issues/${id}`, { headers: admin })).json()).events.length, 2);
    assert.deepEqual(await (await call(`/api/1/events/${payload.event_id}`, { headers: admin })).json(), payload);
  }
  assert.equal((await change({ status: "unresolved" })).status, 200);
  assert.equal((await (await call("/api/1/issues", { headers: admin })).json()).issues.length, 1);
  assert.equal((await call(`/api/1/issues/${id}`, { method: "DELETE", headers: admin })).status, 405);
  assert.equal((await call(`/api/1/events/${payload.event_id}`, { method: "DELETE", headers: admin })).status, 405);
  assert.equal(blobs.size, 2);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM events").get().count, 2);
  delete env.BICHO_ADMIN_TOKEN;
  assert.equal((await call("/api/1/issues", { headers: admin })).status, 503);
  sqlite.close();
});

test("HTTP middleware secures success, errors, preflights, and streamed payloads", async () => {
  const { default: app } = await import("../src/index.ts");
  const { sqlite, env } = bindings();
  env.CORS_ORIGINS = "https://dashboard.test";
  const call = (path, init = {}, protocol = "https") => app.fetch(new Request(`${protocol}://bicho.test${path}`, init), env);
  const headers = { Authorization: "Bearer admin-test-token", Origin: "https://dashboard.test", "X-Request-ID": "untrusted-client-value" };
  for (const [path, init, status] of [
    ["/api/1/issues", { headers }, 200],
    ["/api/1/issues?limit=nope", { headers }, 400],
    ["/api/1/issues", {}, 401],
    ["/missing", {}, 404],
    ["/api/1/issues", { method: "POST" }, 405],
    ["/api/1/issues", { method: "OPTIONS", headers: { Origin: "https://dashboard.test", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } }, 204],
  ]) {
    const response = await call(path, init);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);
    assert.match(response.headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
    assert.equal(response.headers.get("Strict-Transport-Security"), "max-age=31536000");
    assert.match(response.headers.get("X-Request-ID") ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get("X-Powered-By"), null);
    if (init.headers?.Origin === "https://dashboard.test") {
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://dashboard.test");
    }
  }
  const allowed = await call("/api/1/issues", { headers });
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://dashboard.test");
  assert.match(allowed.headers.get("Vary") ?? "", /Origin/);
  assert.match(allowed.headers.get("Access-Control-Expose-Headers") ?? "", /X-Request-ID/);
  const denied = await call("/api/1/issues", { headers: { ...headers, Origin: "https://evil.test" } });
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(denied.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal((await call("/api/1/issues", { headers }, "http")).headers.get("Strict-Transport-Security"), null);
  const wrongMethod = await call("/v1/logs", { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.headers.get("Allow") ?? "", /POST/);
  const ingest = await call("/v1/logs", { method: "POST", body: JSON.stringify(logs([{ ...log("headers"), body: { stringValue: "headers" } }])), headers: { Origin: "https://any-app.test", "Content-Type": "application/json", "X-Bicho-Key": "public" } });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.headers.get("Access-Control-Allow-Origin"), "*");
  const storedId = sqlite.prepare("SELECT id FROM events").get().id;
  const event = await call(`/api/1/events/${storedId}`, { headers });
  assert.equal(event.status, 200);
  assert.equal(event.headers.get("X-Frame-Options"), "DENY");
  assert.equal(event.headers.get("Access-Control-Allow-Origin"), "https://dashboard.test");
  assert.equal((await event.json()).message, "headers");
  const head = await call("/api/1/issues", { method: "HEAD", headers });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await call("/api/1/issues")).headers.get("WWW-Authenticate"), 'Bearer realm="bicho"');
  env.CORS_ORIGINS = "";
  assert.equal((await call("/api/1/issues", { headers })).headers.get("Access-Control-Allow-Origin"), null);
  env.CORS_ORIGINS = "*";
  assert.equal((await call("/api/1/issues", { headers })).headers.get("Access-Control-Allow-Origin"), "*");
  sqlite.close();
});

test("normalized fingerprints override or extend grouping without changing default issue IDs", async () => {
  const { sqlite, env } = bindings();
  let counter = 0;
  const send = async (fields, project = "1") => {
    const id = (++counter).toString(16).padStart(32, "0");
    const response = await capture(env, { event_id: id, ...fields }, project);
    assert.equal(response.status, 200, await response.text());
    return sqlite.prepare("SELECT issue_id FROM events WHERE project_id = ? AND id = ?").get(project, id).issue_id;
  };
  const ordinary = await send({ message: "first" });
  assert.equal(ordinary, hash(JSON.stringify(["Error", "first", null, null, null])));
  assert.equal(await send({ message: "first", fingerprint: ["{{ default }}"] }), ordinary);
  assert.equal(await send({ message: "first", fingerprint: [] }), ordinary);
  const shared = await send({ message: "db host one", fingerprint: ["db-outage"] });
  assert.equal(await send({ message: "db host two", fingerprint: ["db-outage"] }), shared);
  const extended = await send({ message: "first", fingerprint: ["{{ default }}", "tag"] });
  assert.notEqual(extended, ordinary);
  assert.notEqual(await send({ message: "second", fingerprint: ["{{ default }}", "tag"] }), extended);
  assert.notEqual(await send({ fingerprint: ["a|b", "c"] }), await send({ fingerprint: ["a", "b|c"] }));
  assert.equal(await send({ fingerprint: ["db-outage"] }, "2"), shared);
  assert.equal(sqlite.prepare("SELECT event_count FROM issues WHERE project_id = '1' AND id = ?").get(shared).event_count, 2);
  for (const fingerprint of ["bad", null, [1], [{}]]) {
    const response = await capture(env, { fingerprint });
    assert.equal(response.status, 400);
  }
  sqlite.close();
});

test("normalized exception lists and message objects preserve payloads and grouping", async () => {
  const { default: app } = await import("../src/index.ts");
  const { sqlite, env } = bindings();
  let counter = 0;
  const send = async fields => {
    const event = { event_id: (++counter).toString(16).padStart(32, "0"), ...fields };
    const response = await capture(env, event);
    assert.equal(response.status, 200, await response.text());
    const row = sqlite.prepare("SELECT issue_id FROM events WHERE id = ?").get(event.event_id);
    const payload = await app.fetch(new Request(`https://bicho.test/api/1/events/${event.event_id}`, { headers: { Authorization: "Bearer admin-test-token" } }), env);
    assert.deepEqual(await payload.json(), event);
    return row.issue_id;
  };
  const values = [{ type: "RootError", value: "cause" }, { type: "OuterError", value: "failed", stacktrace: { frames: [{ filename: "app.js", function: "main", lineno: 1 }] } }];
  const wrapped = await send({ exception: { values } });
  assert.equal(await send({ exception: values }), wrapped);
  const message = await send({ message: "formatted log" });
  assert.equal(await send({ message: { message: "template", formatted: "formatted log" } }), message);
  assert.equal(await send({ logentry: { message: "template", formatted: "formatted log" } }), message);
  for (const fields of [{ exception: { values: "bad" } }, { exception: [1] }, { message: [] }, { message: { formatted: 1 } }]) {
    const response = await capture(env, fields);
    assert.equal(response.status, 400);
  }
  sqlite.close();
});

test("ingest bounds wire bytes and decoded bytes even without trustworthy lengths", async () => {
  const { default: app } = await import("../src/index.ts");
  const { sqlite, env } = bindings();
  const event = JSON.stringify(logs([log("bounded")]));
  const compressed = gzipSync(event);
  const header = Buffer.from(compressed.subarray(0, 10));
  header[3] |= 16;
  const padded = Buffer.concat([header, Buffer.alloc(2 * 1024 * 1024, 97), Buffer.from([0]), compressed.subarray(10)]);
  const send = body => app.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", "X-Bicho-Key": "public", "Content-Encoding": "gzip", "Content-Length": "1" }, body }), env);
  assert.equal((await send(padded)).status, 413);
  assert.equal((await send(gzipSync("x".repeat(2 * 1024 * 1024 + 1)))).status, 413);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM events").get().count, 0);
  assert.equal((await send(compressed)).status, 200);
  sqlite.close();
});


test("normalized captures group, deduplicate, and expose project-scoped read API", async () => {
  const { default: worker } = await import("../src/index.ts");
  const { sqlite, blobs, env } = bindings();
  const request = (path, init) => worker.fetch(new Request(`https://bicho.test${path}`, init), env);
  const send = event => capture(env, event);
  const event = { event_id: "a".repeat(32), message: "boom", environment: "production", release: "v1" };
  assert.equal((await send(event)).status, 200);
  assert.equal((await send(event)).status, 200);
  assert.equal((await send({ ...event, event_id: "b".repeat(32) })).status, 200);
  assert.equal(blobs.size, 2);
  const read = (path, token = "admin-test-token") => request(path, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await request("/api/1/issues")).status, 401);
  assert.equal((await read("/api/1/issues", "public")).status, 401);
  const list = await (await read("/api/1/issues?q=boom&environment=production")).json();
  assert.equal(list.issues.length, 1);
  assert.equal(list.issues[0].event_count, 2);
  const id = list.issues[0].id;
  const detail = await (await read(`/api/1/issues/${id}`)).json();
  assert.equal(detail.events.length, 2);
  assert.deepEqual(await (await read(`/api/1/events/${event.event_id}`)).json(), event);
  assert.equal((await read(`/api/2/events/${event.event_id}`, "admin-test-token")).status, 404);
  assert.equal((await read("/api/1/issues?limit=nope")).status, 400);
  assert.equal((await send({ event_id: "bad", message: "bad" })).status, 400);
  const cors = await request("/v1/logs", { method: "OPTIONS", headers: { Origin: "https://example.com" } });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get("Access-Control-Allow-Origin"), "*");
  const readCors = await request("/api/1/issues", { method: "OPTIONS", headers: { Origin: "https://dashboard.test", "Access-Control-Request-Headers": "authorization" } });
  assert.equal(readCors.status, 204);
  assert.match(readCors.headers.get("Access-Control-Allow-Headers") ?? "", /Authorization/);
  sqlite.close();
});

test("normalized exception grouping and pagination", async () => {
  const { default: worker } = await import("../src/index.ts");
  const { sqlite, env } = bindings();
  const call = (path, init) => worker.fetch(new Request(`https://bicho.test${path}`, init), env);
  const event = (id, line = 10) => ({ event_id: id.repeat(32), timestamp: 1700000000,
    exception: { values: [{ type: "TypeError", value: "broken", stacktrace: { frames: [{ filename: "app.ts", function: "main", lineno: line }] } }] } });
  assert.equal((await capture(env, event("c"))).status, 200);
  assert.equal((await capture(env, event("d"))).status, 200);
  assert.equal((await capture(env, event("e", 11))).status, 200);
  const read = (path) => call(path, { headers: { Authorization: "Bearer admin-test-token" } });
  const issues = await (await read("/api/1/issues")).json();
  assert.equal(issues.issues.length, 2);
  assert.deepEqual(issues.issues.map(issue => issue.event_count).sort(), [1, 2]);
  const page = await (await read("/api/1/issues?limit=1")).json();
  assert.equal(page.issues.length, 1);
  assert.equal(page.next_offset, 1);
  assert.equal((await (await read("/api/1/issues?limit=1&offset=1")).json()).next_offset, null);
  assert.equal((await capture(env, { ...event("c"), message: "different", exception: undefined })).status, 200);
  assert.equal((await (await read("/api/1/issues")).json()).issues.length, 2);
  sqlite.close();
});

test("storage failures do not create dangling indexes or lose committed payloads", async () => {
  const { default: worker } = await import("../src/index.ts");
  const { sqlite, blobs, env } = bindings();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = () => worker.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", "X-Bicho-Key": "public" }, body: JSON.stringify(logs([log("storage-failure")])) }), env);
  const originalPut = env.PAYLOADS.put;
  env.PAYLOADS.put = async () => { throw new Error("R2 unavailable"); };
  const failure = await send();
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { code: 14, message: "Ingestion temporarily unavailable" });
  assert.equal(failure.headers.get("X-Frame-Options"), "DENY");
  assert.equal(failure.headers.get("Cache-Control"), "no-store");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM events").get().count, 0);
  env.PAYLOADS.put = originalPut;
  sqlite.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'failure'); END;");
  assert.equal((await send()).status, 503);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM issues").get().count, 0);
  assert.equal(blobs.size, 1);
  sqlite.exec("DROP TRIGGER reject_event");
  assert.equal((await send()).status, 200);
  assert.equal(sqlite.prepare("SELECT event_count FROM issues").get().event_count, 1);
  const key = sqlite.prepare("SELECT payload_key FROM events").get().payload_key;
  assert.ok(blobs.has(key));
  blobs.delete(key);
  const storedId = sqlite.prepare("SELECT id FROM events").get().id;
  const missing = await worker.fetch(new Request(`https://bicho.test/api/1/events/${storedId}`, { headers: { Authorization: "Bearer admin-test-token" } }), env);
  assert.equal(missing.status, 503);
  sqlite.close();
});


test("REST failures return generic errors and log request IDs without credentials", async () => {
  const { default: worker } = await import("../src/index.ts");
  const { sqlite, env } = bindings();
  try {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("Bearer private-secret"); });
    const response = await worker.fetch(new Request("https://bicho.test/api/1/issues?token=private-secret", { headers: { Authorization: "Bearer admin-test-token" } }), env);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const logged = JSON.parse(console.error.mock.calls[0][0]);
    assert.equal(logged.request_id, response.headers.get("X-Request-ID"));
    assert.equal(logged.path, "/api/1/issues");
    assert.ok(!JSON.stringify(logged).includes("private-secret"));
  } finally { sqlite.close(); }
});
