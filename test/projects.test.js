import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import worker from "../src/index.ts";
import { bindings, logs, log } from "./helpers.js";

const auth = { Authorization: "Bearer admin-test-token" };

test("project registration is admin-only, generates credentials, and never replaces existing projects", async () => {
  const { sqlite, env } = bindings();
  const call = (path, init = {}, bindings = env) => worker.fetch(new Request(`https://bicho.test${path}`, init), bindings);
  const create = (input, headers = auth, bindings = env) => call("/api/projects", { method: "POST", headers, body: JSON.stringify(input) }, bindings);
  try {
    for (const headers of [{}, { Authorization: "Bearer public" }, { "X-Bicho-Key": "public" }]) assert.equal((await create({ name: "denied" }, headers)).status, 401);
    assert.equal((await create({ name: "denied" }, auth, { ...env, BICHO_ADMIN_TOKEN: undefined })).status, 503);
    for (const input of [{}, null, [], { name: " " }, { name: 1 }, { name: "x".repeat(513) }, { name: "test", id: "1" }, { name: "test", public_key: "public" }, { name: "test", secret: "yes" }, ...[null, 0, -1, 1.5, "1", 1000001].map(hourly_limit => ({ name: "test", hourly_limit }))]) {
      assert.equal((await create(input)).status, 400, JSON.stringify(input));
    }
    for (const [body, status] of [["{", 400], ["x".repeat(4097), 413]]) assert.equal((await call("/api/projects", { method: "POST", headers: auth, body })).status, status);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM projects").get().n, 2);
    const registrations = [];
    for (const secret of [false, true]) {
      const response = await create({ name: " test ", secret, hourly_limit: 25 });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const value = await response.json();
      registrations.push(value);
      assert.match(value.project.id, /^[1-9]\d{0,18}$/);
      assert.deepEqual(value.project, { id: value.project.id, name: "test", hourly_limit: 25 });
      assert.equal(value.otlp.endpoint, "https://bicho.test/v1/logs");
      assert.match(value.otlp.headers["X-Bicho-Key"], /^[a-f0-9]{32}$/);
      const row = sqlite.prepare("SELECT * FROM projects WHERE id=?").get(value.project.id);
      assert.equal(row.public_key, value.otlp.headers["X-Bicho-Key"]);
      if (secret) {
        assert.match(value.otlp.headers["X-Bicho-Secret"], /^[a-f0-9]{64}$/);
        assert.equal(row.secret_hash, createHash("sha256").update(value.otlp.headers["X-Bicho-Secret"]).digest("hex"));
      } else assert.equal(row.secret_hash, null);
      const ingest = headers => call("/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(logs([log(`project-${secret}`)])) });
      if (secret) assert.equal((await ingest({ "X-Bicho-Key": row.public_key })).status, 403);
      assert.equal((await ingest(value.otlp.headers)).status, 200);
      assert.equal(sqlite.prepare("SELECT count(*) AS n FROM events WHERE project_id=?").get(value.project.id).n, 1);
      assert.equal((await call(`/api/${value.project.id}/issues`, { headers: { Authorization: `Bearer ${row.public_key}` } })).status, 401);
      for (const method of ["DELETE", "PUT", "PATCH"]) assert.equal((await call("/api/projects", { method, headers: auth })).status, 405);
    }
    assert.notEqual(registrations[0].project.id, registrations[1].project.id);
    assert.notEqual(registrations[0].otlp.headers["X-Bicho-Key"], registrations[1].otlp.headers["X-Bicho-Key"]);
    const listed = await (await call("/api/projects", { headers: auth })).json();
    for (const value of registrations) assert.deepEqual(listed.projects.find(p => p.id === value.project.id), value.project);
    assert.ok(!JSON.stringify(listed).includes("public_key"));
    assert.ok(!JSON.stringify(listed).includes("secret"));
    assert.equal(sqlite.prepare("SELECT public_key FROM projects WHERE id='1'").get().public_key, "public");
    const response = await create({ name: "defaults" });
    assert.equal((await response.json()).project.hourly_limit, 1000);
    const preflight = await call("/api/projects", { method: "OPTIONS", headers: { Origin: "https://dashboard.test", "Access-Control-Request-Method": "POST" } });
    assert.match(preflight.headers.get("Access-Control-Allow-Methods"), /POST/);
  } finally { sqlite.close(); }
});
