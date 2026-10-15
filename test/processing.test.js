import { test } from "vitest";
import assert from "node:assert/strict";
import { bindings, capture as captureEvent, logs, log } from "./helpers.js";
import app from "../src/index.ts";
import { processEnrichment, uploadSourceMap } from "../src/enrichment.ts";
import { putJson, readJson, redact } from "../src/payload.ts";

const debugId = "12345678-1234-4234-8234-123456789abc";
const map = { version: 3, sources: ["original.ts"], names: [], mappings: "AAAA", sourcesContent: ["throw new Error('boom')"] };
const frame = (extra = {}) => ({ filename: "bundle.js", debug_id: debugId, lineno: 1, colno: 1, ...extra });
const row = (b, id) => b.sqlite.prepare("SELECT * FROM events WHERE id=?").get(id);

async function capture(b, id, frames) {
  b.sqlite.exec("INSERT OR IGNORE INTO issues(project_id,id,title,type,first_seen,last_seen) VALUES ('1','issue','test','Error','2026-01-01','2026-01-01')");
  const key = `raw/${id}`;
  await putJson(b.env, key, { stacktrace: { frames } });
  b.sqlite.prepare("INSERT INTO events(project_id,id,issue_id,timestamp,received_at,level,payload_key,enrichment_status) VALUES ('1',?,'issue','2026-01-01','2026-01-01','error',?,'pending')").run(id, key);
  return key;
}

function expireCooldown(b) {
  b.sqlite.exec("UPDATE processing_state SET last_started_at='2026-01-01T00:00:00.000Z'");
}

function countQueries(b) {
  let count = 0;
  const prepare = b.env.DB.prepare;
  b.env.DB.prepare = sql => { count++; return prepare(sql); };
  return () => count;
}

test("credential-pair filtering cannot merge distinct normalized fingerprints", async () => {
  const b = bindings();
  try {
    for (const [id, part] of [["a", "one"], ["b", "two"]]) {
      const event = { event_id: id.repeat(32), message: "same", fingerprint: ["password", part], tags: [["password", "private"]], request: { headers: [["Cookie", "private"]] } };
      const response = await captureEvent(b.env, event);
      assert.equal(response.status, 200);
    }
    assert.equal(b.sqlite.prepare("SELECT count(*) AS count FROM issues").get().count, 2);
    assert.deepEqual(redact({ extra: ["password", "ordinary"], tags: [["password", "private"]], headers: [["Cookie", "private"]] }), { extra: ["password", "ordinary"], tags: [["password", "[Filtered]"]], headers: [["Cookie", "[Filtered]"]] });
  } finally { b.sqlite.close(); }
});

test("lookup budgets persist frame progress and eventually inspect every accepted frame", async () => {
  const b = bindings();
  try {
    await capture(b, "many", Array.from({ length: 1000 }, (_, index) => frame({ debug_id: `${(index + 1).toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc` })));
    const queries = countQueries(b);
    let before = queries();
    await processEnrichment(b.env);
    assert.ok(queries() - before <= 200, `Used ${queries() - before} D1 queries`);
    assert.equal(row(b, "many").enrichment_cursor, 100);
    const partial = await readJson(b.env, row(b, "many").enrichment_key);
    assert.equal(partial.truncation_reason, "lookup_budget");
    assert.equal(partial.processed_frames, 100);
    for (let index = 1; index < 10; index++) {
      expireCooldown(b);
      before = queries();
      await processEnrichment(b.env);
      assert.ok(queries() - before <= 200);
    }
    const final = await readJson(b.env, row(b, "many").enrichment_key);
    assert.equal(final.processed_frames, 1000);
    assert.equal(final.truncated, false);
    assert.equal(final.status, "pending");
    assert.equal(new Set(final.frames.map(item => item.path)).size, 1000);
    before = queries();
    await processEnrichment(b.env);
    assert.equal(queries() - before, 1);
  } finally { b.sqlite.close(); }
});

test("missing maps sleep without scans or writes and an upload wakes their project", async () => {
  const b = bindings();
  try {
    await capture(b, "waiting", [frame()]);
    await processEnrichment(b.env);
    const state = b.sqlite.prepare("SELECT * FROM processing_state").get();
    const key = row(b, "waiting").enrichment_key;
    const queries = countQueries(b);
    await processEnrichment(b.env);
    assert.equal(queries(), 1);
    assert.deepEqual(b.sqlite.prepare("SELECT * FROM processing_state").get(), state);
    assert.equal(row(b, "waiting").enrichment_key, key);
    await uploadSourceMap(new Request("https://bicho.test/map", { method: "PUT", body: JSON.stringify(map) }), b.env, { id: "1" }, debugId);
    expireCooldown(b);
    await processEnrichment(b.env);
    assert.equal(row(b, "waiting").enrichment_status, "succeeded");
  } finally { b.sqlite.close(); }
});

test("transient storage failures back off and retry, but stop after three attempts", async () => {
  const b = bindings();
  try {
    const key = await capture(b, "broken", [frame()]);
    const get = b.env.PAYLOADS.get;
    b.env.PAYLOADS.get = async name => { if (name === key) throw new Error("storage unavailable"); return get(name); };
    await processEnrichment(b.env);
    assert.equal(row(b, "broken").enrichment_status, "failed");
    expireCooldown(b);
    await processEnrichment(b.env);
    for (let index = 1; index < 3; index++) {
      b.sqlite.exec("UPDATE events SET enrichment_checked_at='2026-01-01T00:00:00.000Z'");
      expireCooldown(b);
      await processEnrichment(b.env);
    }
    assert.equal(row(b, "broken").enrichment_attempts, 3);
    b.env.PAYLOADS.get = get;
    b.sqlite.exec("UPDATE events SET enrichment_checked_at='2026-01-01T00:00:00.000Z'");
    expireCooldown(b);
    const queries = countQueries(b);
    await processEnrichment(b.env);
    assert.equal(queries(), 1);
    assert.equal(row(b, "broken").enrichment_status, "failed");
  } finally { b.sqlite.close(); }
});

test("map uploads invalidate failed continuations without bypassing retry backoff", async () => {
  const b = bindings();
  try {
    const frames = Array.from({ length: 101 }, (_, index) => frame({ debug_id: `${(index + 1).toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc` }));
    const key = await capture(b, "resume", frames);
    const original = b.blobs.get(key).slice();
    await processEnrichment(b.env);
    assert.equal(row(b, "resume").enrichment_cursor, 100);
    const get = b.env.PAYLOADS.get;
    b.env.PAYLOADS.get = async name => { if (name === key) throw new Error("storage unavailable"); return get(name); };
    expireCooldown(b);
    await processEnrichment(b.env);
    b.env.PAYLOADS.get = get;
    const failed = row(b, "resume");
    assert.equal(failed.enrichment_status, "failed");
    assert.equal(failed.enrichment_cursor, 100);
    await uploadSourceMap(new Request("https://bicho.test/map", { method: "PUT", body: JSON.stringify(map) }), b.env, { id: "1" }, frames[0].debug_id);
    const invalidated = row(b, "resume");
    assert.equal(invalidated.enrichment_cursor, 0);
    assert.equal(invalidated.enrichment_revision, failed.enrichment_revision + 1);
    assert.equal(invalidated.enrichment_checked_at, failed.enrichment_checked_at);
    assert.equal(invalidated.enrichment_attempts, failed.enrichment_attempts);
    expireCooldown(b);
    await processEnrichment(b.env);
    assert.deepEqual(row(b, "resume"), invalidated);
    b.sqlite.exec("UPDATE events SET enrichment_checked_at='2026-01-01T00:00:00.000Z' WHERE id='resume'");
    await processEnrichment(b.env);
    expireCooldown(b);
    await processEnrichment(b.env);
    const evidence = await readJson(b.env, row(b, "resume").enrichment_key);
    assert.equal(evidence.processed_frames, 101);
    assert.equal(evidence.frames[0].mapped.filename, "original.ts");
    assert.equal(evidence.frames[0].reason, undefined);
    assert.deepEqual(b.blobs.get(key), original);
  } finally { b.sqlite.close(); }
});

test("ingestion triggers background enrichment without waiting for an hourly cron", async () => {
  const b = bindings();
  try {
    await uploadSourceMap(new Request("https://bicho.test/map", { method: "PUT", body: JSON.stringify(map) }), b.env, { id: "1" }, debugId);
    const promises = [];
    const context = { waitUntil(promise) { promises.push(promise); } };
    const event = { event_id: "c".repeat(32), message: "trigger", stacktrace: { frames: [frame()] } };
    assert.equal((await captureEvent(b.env, event)).status, 200);
    const response = await app.fetch(new Request("https://bicho.test/v1/logs", { method: "POST", headers: { "Content-Type": "application/json", "X-Bicho-Key": "public" }, body: JSON.stringify(logs([log("trigger")])) }), b.env, context);
    assert.equal(response.status, 200);
    assert.equal(promises.length, 1);
    await Promise.all(promises);
    assert.equal(row(b, event.event_id).enrichment_status, "succeeded");
  } finally { b.sqlite.close(); }
});

test("permanent invalid positions never rewrite derived evidence on later runs", async () => {
  const b = bindings();
  try {
    await capture(b, "invalid", [frame({ colno: undefined })]);
    await processEnrichment(b.env);
    assert.equal(row(b, "invalid").enrichment_status, "failed");
    const key = row(b, "invalid").enrichment_key;
    const bytes = b.blobs.get(key).slice();
    let writes = 0;
    const put = b.env.PAYLOADS.put;
    b.env.PAYLOADS.put = async (...args) => { writes++; return put(...args); };
    expireCooldown(b);
    await processEnrichment(b.env);
    assert.equal(writes, 0);
    assert.deepEqual(b.blobs.get(key), bytes);
  } finally { b.sqlite.close(); }
});

test("an upload during processing cannot be lost behind a stale missing-map result", async () => {
  const b = bindings();
  let release;
  try {
    await capture(b, "race", [frame()]);
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const put = b.env.PAYLOADS.put;
    b.env.PAYLOADS.put = async (...args) => { if (args[0].startsWith("enrichment/")) { entered(); await blocked; } return put(...args); };
    const old = processEnrichment(b.env);
    await started;
    await uploadSourceMap(new Request("https://bicho.test/map", { method: "PUT", body: JSON.stringify(map) }), b.env, { id: "1" }, debugId);
    release();
    await old;
    assert.equal(row(b, "race").enrichment_checked_at, null);
    expireCooldown(b);
    await processEnrichment(b.env);
    assert.equal(row(b, "race").enrichment_status, "succeeded");
  } finally { release?.(); b.sqlite.close(); }
});
