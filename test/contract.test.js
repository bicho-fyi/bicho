import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import app from "../src/index.ts";
import { bindings, capture, logs, log } from "./helpers.js";

test("root redirects without forwarding queries or changing unknown routes", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await app.fetch(new Request("https://bicho.test/?source=private", { method }), {});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "https://bicho.fyi");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "");
  }
  assert.equal((await app.fetch(new Request("https://bicho.test/missing"), {})).status, 404);
  assert.equal((await app.fetch(new Request("https://bicho.test/", { method: "POST" }), {})).status, 404);
  for (const method of ["GET", "POST", "OPTIONS"]) {
    const response = await app.fetch(new Request("https://bicho.test/api/1/unsupported", { method }), {});
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
});

const load = () => JSON.parse(readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
const auth = { Authorization: "Bearer admin-test-token" };

test("repository OpenAPI covers every explicit route without exposing docs on the Worker", async () => {
  const doc = load();
  assert.equal(doc.openapi, "3.1.1");
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const implemented = [...source.matchAll(/app\.(get|post|put|patch)\("([^"]+)"/g)].map(([, method, path]) => `${method} ${path.replace(/:([a-z_]+)/g, "{$1}")}`).sort();
  const documented = Object.entries(doc.paths).flatMap(([path, item]) => Object.keys(item).filter(method => ["get", "post", "put", "patch"].includes(method)).map(method => `${method} ${path}`)).sort();
  assert.deepEqual(documented, implemented);
  const b = bindings();
  try {
    for (const path of ["/openapi.json", "/docs", "/swagger.json"]) assert.equal((await app.fetch(new Request(`https://bicho.test${path}`), b.env)).status, 404);
    for (const [path, item] of Object.entries(doc.paths)) {
      if (path === "/") {
        assert.deepEqual(item.get.security, []);
        continue;
      }
      if (path.endsWith("/envelope") || path.endsWith("/store")) {
        assert.ok(item.post.security.some(scheme => "SentryQuery" in scheme));
        continue;
      }
      if (path === "/v1/logs") {
        assert.deepEqual(item.post.security, [{ OTLPIngest: [] }]);
        continue;
      }

      for (const method of ["get", "post", "put", "patch"]) if (item[method]) assert.deepEqual(item[method].security ?? doc.security, [{ AdminBearer: [] }]);
    }
  } finally { b.sqlite.close(); }
});

test("actual success and auth-error responses match the repository contract", async () => {
  const doc = load();
  const validator = new AjvJsonSchemaValidator();
  const b = bindings();
  const call = (path, init = {}) => app.fetch(new Request(`https://bicho.test${path}`, init), b.env);
  const validate = async (route, method, response) => {
    const documented = doc.paths[route][method].responses[String(response.status)];
    const responseSpec = documented.$ref ? doc.components.responses[documented.$ref.split("/").at(-1)] : documented;
    const schema = responseSpec.content["application/json"].schema;
    const value = await response.json();
    const check = validator.getValidator({ ...schema, components: doc.components });
    const result = check(value);
    assert.equal(result.valid, true, `${method} ${route}: ${result.errorMessage}`);
    return { value, check };
  };
  try {
    const event = { event_id: "a".repeat(32), message: "contract", timestamp: "2026-10-01T10:00:00Z", tags: { route: "/test" }, release: "v1" };
    assert.equal((await capture(b.env, event)).status, 200);
    await validate("/v1/logs", "post", await call("/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", "X-Bicho-Key": "public" }, body: JSON.stringify(logs([log("contract")])) }));
    for (const endpoint of ["envelope", "store"]) {
      const event = JSON.stringify({ event_id: "c".repeat(32), message: "Sentry contract" });
      const body = endpoint === "store" ? event : '{}\n{"type":"event"}\n' + event;
      const path = `/api/1/${endpoint}?sentry_version=7&sentry_key=public`;
      await validate(`/api/{project_id}/${endpoint}`, "post", await call(path, { method: "POST", body }));
      await validate(`/api/{project_id}/${endpoint}`, "post", await call(`/api/1/${endpoint}`, { method: "POST", body }));
    }
    const { value: projects, check } = await validate("/api/projects", "get", await call("/api/projects", { headers: auth }));
    assert.equal(check({ ...projects, projects: [{ id: 1 }] }).valid, false);
    await validate("/api/projects", "post", await call("/api/projects", { method: "POST", headers: auth, body: '{"name":"contract project","secret":true}' }));
    await validate("/api/projects", "post", await call("/api/projects", { method: "POST", body: '{"name":"denied"}' }));
    const issue = b.sqlite.prepare("SELECT id FROM issues").get().id;
    for (const [route, path] of [
      ["/api/{project_id}/issues", "/api/1/issues"],
      ["/api/{project_id}/issues/{id}", `/api/1/issues/${issue}`],
      ["/api/{project_id}/events", "/api/1/events"],
      ["/api/{project_id}/events/{id}", `/api/1/events/${event.event_id}`],
      ["/api/{project_id}/events/{id}", `/api/1/events/${event.event_id}?fields=message&include_enrichment=1`],
      ["/api/{project_id}/releases", "/api/1/releases"],
      ["/api/{project_id}/stats", "/api/1/stats?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z"],
      ["/api/{project_id}/processing", "/api/1/processing"],
    ]) await validate(route, "get", await call(path, { headers: auth }));
    await validate("/api/{project_id}/issues/{id}", "patch", await call(`/api/1/issues/${issue}`, { method: "PATCH", headers: auth, body: '{"status":"resolved"}' }));
    await validate("/api/{project_id}/issues/{id}/history", "get", await call(`/api/1/issues/${issue}/history`, { headers: auth }));
    const debugId = "12345678-1234-4234-8234-123456789abc";
    const mapPath = `/api/1/sourcemaps/${debugId}`;
    const map = { version: 3, sources: ["original.ts"], names: [], mappings: "AAAA" };
    await validate("/api/{project_id}/sourcemaps/{debug_id}", "put", await call(mapPath, { method: "PUT", headers: auth, body: JSON.stringify(map) }));
    await validate("/api/{project_id}/sourcemaps/{debug_id}", "get", await call(mapPath, { headers: auth }));
    await validate("/api/projects", "get", await call("/api/projects"));
  } finally { b.sqlite.close(); }
});

test("MCP transport errors are documented as JSON-RPC rather than REST errors", async () => {
  const doc = load();
  const validator = new AjvJsonSchemaValidator();
  const b = bindings();
  try {
    const headers = { ...auth, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const [expected, inputHeaders, input] of [[200, headers, body], [400, headers, "{"], [406, { ...headers, Accept: "application/json" }, body], [415, { ...headers, "Content-Type": "text/plain" }, body], [413, headers, "x".repeat(65537)]]) {
      const response = await app.fetch(new Request("https://bicho.test/mcp", { method: "POST", headers: inputHeaders, body: input }), b.env);
      assert.equal(response.status, expected);
      const documented = doc.paths["/mcp"].post.responses[String(expected)];
      assert.ok(documented, `Missing MCP HTTP ${expected} response`);
      const responseSpec = documented.$ref ? doc.components.responses[documented.$ref.split("/").at(-1)] : documented;
      const check = validator.getValidator({ ...responseSpec.content["application/json"].schema, components: doc.components });
      const result = check(await response.json());
      assert.equal(result.valid, true, result.errorMessage);
    }
  } finally { b.sqlite.close(); }
});
