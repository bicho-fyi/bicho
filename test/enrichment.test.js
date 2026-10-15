import { test, beforeEach, afterEach, vi } from "vitest";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-13T00:00:00.000Z") }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
import assert from "node:assert/strict";
import { bindings } from "./helpers.js";
import { putJson, readJson } from "../src/payload.ts";

const id = "12345678-1234-4234-8234-123456789abc";
const project = { id: "1" };
const map = { version: 3, sources: ["original.js"], names: ["original"], mappings: "AAAAA,KACGA", sourcesContent: ["before\nBearer secret-value\nafter"] };
const request = value => new Request("https://bicho.test/map", { method: "PUT", body: JSON.stringify(value) });

async function module() { return import("../src/enrichment.ts"); }

async function event(b, name, payload, projectId = "1") {
  b.sqlite.prepare("INSERT OR IGNORE INTO issues (project_id,id,title,type,first_seen,last_seen) VALUES (?, 'issue','test','Error','2026-01-01','2026-01-01')").run(projectId);
  const key = `raw/${projectId}/${name}`;
  await putJson(b.env, key, payload);
  b.sqlite.prepare("INSERT INTO events (project_id,id,issue_id,timestamp,received_at,level,payload_key,enrichment_status) VALUES (?,?,'issue','2026-01-01','2026-01-01','error',?,'pending')").run(projectId, name, key);
  return key;
}
const row = (b, name, projectId = "1") => b.sqlite.prepare("SELECT * FROM events WHERE project_id=? AND id=?").get(projectId, name);
const frame = (extra = {}) => ({ filename: "bundle.js", debug_id: id, lineno: 1, colno: 6, ...extra });

test("absolute source labels never fetch remotely and optional empty debug metadata is accepted", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected remote fetch"); });
  await uploadSourceMap(request({ ...map, sources: ["https://example.test/original.js"] }), b.env, project, id);
  const otherId = "22345678-1234-4234-8234-123456789abc";
  await uploadSourceMap(request({ ...map, sourceRoot: "https://example.test/" }), b.env, project, otherId);
  await event(b, "empty", { stacktrace: { frames: [frame()] }, debug_meta: {} });
  await event(b, "null", { stacktrace: { frames: [frame({ debug_id: otherId })] }, debug_meta: null });
  await processEnrichment(b.env);
  for (const name of ["empty", "null"]) {
    assert.equal(row(b, name).enrichment_status, "succeeded");
    assert.equal((await readJson(b.env, row(b, name).enrichment_key)).frames[0].mapped.filename, "https://example.test/original.js");
  }
  b.sqlite.close();
});

test("source-map uploads wake sleeping pending events without starvation by new events", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  for (let index = 0; index < 25; index++) await event(b, `old${index}`, { stacktrace: { frames: [frame()] } });
  await processEnrichment(b.env);
  b.sqlite.exec("UPDATE events SET enrichment_checked_at='2026-10-12T00:00:00.000Z'");
  for (let index = 0; index < 25; index++) await event(b, `new${index}`, { stacktrace: { frames: [frame()] } });
  b.sqlite.exec("UPDATE events SET received_at='2026-10-12T00:01:00.000Z' WHERE id LIKE 'new%'");
  await uploadSourceMap(request(map), b.env, project, id);
  vi.advanceTimersByTime(60001);
  await processEnrichment(b.env);
  assert.equal(b.sqlite.prepare("SELECT count(*) AS count FROM events WHERE id LIKE 'old%' AND enrichment_checked_at='2026-10-12T00:00:00.000Z'").get().count, 0);
  b.sqlite.close();
});

test("an expired failed lease cannot replace newer processing health", async () => {
  const { processEnrichment } = await module();
  const b = bindings();
  await event(b, "candidate", { stacktrace: { frames: [frame()] } });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const prepare = b.env.DB.prepare;
  let first = true;
  b.env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT project_id,id,payload_key") && first) {
      first = false;
      statement.all = async () => { entered(); await blocked; throw new Error("stale failure"); };
    }
    return statement;
  };
  const old = processEnrichment(b.env);
  await started;
  vi.advanceTimersByTime(5 * 60000 + 1);
  await processEnrichment(b.env);
  release();
  await assert.rejects(old, /Source map processing failed/);
  const state = b.sqlite.prepare("SELECT * FROM processing_state WHERE name='source_maps'").get();
  assert.equal(state.error, null);
  assert.equal(state.failed, 0);
  assert.notEqual(state.last_finished_at, null);
  b.sqlite.close();
});

test("missing maps retry to mapped captured positions without changing raw gzip bytes", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  const key = await event(b, "event", { exception: { values: [{ stacktrace: { frames: [frame()] } }] } });
  const original = b.blobs.get(key).slice();
  await processEnrichment(b.env);
  assert.equal(row(b, "event").enrichment_status, "pending");
  const pending = await readJson(b.env, row(b, "event").enrichment_key);
  assert.equal(pending.frames[0].reason, "missing_source_map");
  await uploadSourceMap(request(map), b.env, project, id);
  vi.advanceTimersByTime(60001);
  await processEnrichment(b.env);
  assert.equal(row(b, "event").enrichment_status, "succeeded");
  const enriched = await readJson(b.env, row(b, "event").enrichment_key);
  assert.equal(enriched.version, 1);
  assert.equal(enriched.frames[0].mapped.filename, "original.js");
  assert.equal(enriched.frames[0].mapped.function, "original");
  assert.equal(enriched.frames[0].mapped.lineno, 2);
  assert.equal(enriched.frames[0].mapped.colno, 4);
  assert.equal(enriched.frames[0].mapped.context_line, "Bearer [Filtered]");
  assert.deepEqual(enriched.frames[0].mapped.pre_context, ["before"]);
  assert.deepEqual(enriched.frames[0].mapped.post_context, ["after"]);
  assert.deepEqual(enriched.frames[0].captured, frame());
  assert.deepEqual(b.blobs.get(key), original);
  const derivedKey = row(b, "event").enrichment_key;
  await processEnrichment(b.env);
  assert.equal(row(b, "event").enrichment_key, derivedKey);
  assert.equal(b.sqlite.prepare("SELECT event_count FROM issues").get().event_count, 1);
});

test("immutable project-scoped uploads validate UUIDs and return metadata only", async () => {
  const { uploadSourceMap, getSourceMap } = await module();
  const b = bindings();
  assert.equal((await uploadSourceMap(request(map), b.env, project, id)).status, 201);
  assert.equal((await uploadSourceMap(request(map), b.env, project, id.toUpperCase())).status, 200);
  await assert.rejects(uploadSourceMap(request({ ...map, names: ["changed"] }), b.env, project, id), error => error.status === 409);
  await assert.rejects(uploadSourceMap(request(map), b.env, project, id.replaceAll("-", "")), error => error.status === 400);
  await assert.rejects(getSourceMap(b.env, { id: "2" }, id), error => error.status === 404);
  const metadata = await (await getSourceMap(b.env, project, id)).json();
  assert.equal(metadata.debug_id, id);
  assert.equal(metadata.mappings, undefined);
  assert.equal(metadata.sourcesContent, undefined);
  assert.equal(metadata.payload_key, undefined);
  assert.equal(b.blobs.size, 1);
});

test("rejects unsupported, malicious and oversized maps without storing objects", async () => {
  const { uploadSourceMap } = await module();
  const b = bindings();
  for (const value of [
    { ...map, version: 2 }, { ...map, sections: [] }, { ...map, url: "https://example.com/map" },
    { ...map, sources: [42] }, { ...map, sourcesContent: [42] },
    { ...map, names: ["x".repeat(4097)] }, { ...map, sourcesContent: [] },
    ...["!", "g", "AA", "AAAAAA", "ACAA", "AAAAC", "DAAA", "AAAA,", "ggggggEAAA", ";".repeat(50000), Array.from({ length: 50001 }, () => "AAAA").join(",")].map(mappings => ({ ...map, mappings })),
    { ...map, debug_id: id.replaceAll("-", "") },
  ]) await assert.rejects(uploadSourceMap(request(value), b.env, project, id), error => error.status === 400);
  await assert.rejects(uploadSourceMap(request({ ...map, sourcesContent: ["x".repeat(2 * 1024 * 1024)] }), b.env, project, id), error => error.status === 413);
  assert.equal(b.blobs.size, 0);
});

test("concurrent registrations retain only the canonical object including uppercase retries", async () => {
  const { uploadSourceMap } = await module();
  const b = bindings();
  const responses = await Promise.all([uploadSourceMap(request(map), b.env, project, id), uploadSourceMap(request(map), b.env, project, id.toUpperCase())]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  assert.equal(b.sqlite.prepare("SELECT count(*) AS count FROM source_maps").get().count, 1);
  assert.equal(b.blobs.size, 1);
  const otherId = "22345678-1234-4234-8234-123456789abc";
  const race = await Promise.allSettled([uploadSourceMap(request(map), b.env, project, otherId), uploadSourceMap(request({ ...map, names: ["different"] }), b.env, project, otherId)]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(race.find(result => result.status === "rejected").reason.status, 409);
  assert.equal(b.blobs.size, 2);
});

test("associates exact debug image filenames across exception and thread chains", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  await uploadSourceMap(request(map), b.env, project, id);
  const indirect = frame();
  delete indirect.debug_id;
  await event(b, "flat", { exception: [{ stacktrace: { frames: [indirect] } }], threads: { values: [{ stacktrace: { frames: [frame()] } }] }, stacktrace: { frames: [frame()] }, debug_meta: { images: [{ type: "sourcemap", debug_id: id, code_file: "bundle.js" }] } });
  await event(b, "abs", { threads: [{ stacktrace: { frames: [{ ...indirect, filename: "other", abs_path: "bundle.js" }] } }], debug_meta: { images: [{ type: "sourcemap", debug_id: id, code_file: "bundle.js" }] } });
  await event(b, "nomatch", { stacktrace: { frames: [indirect] }, debug_meta: { images: [{ type: "sourcemap", debug_id: id, code_file: "https://example.com/bundle.js" }] } });
  await event(b, "ambiguous", { stacktrace: { frames: [indirect] }, debug_meta: { images: [{ type: "sourcemap", debug_id: id, code_file: "bundle.js" }, { type: "sourcemap", debug_id: "22345678-1234-4234-8234-123456789abc", code_file: "bundle.js" }] } });
  await processEnrichment(b.env);
  assert.equal(row(b, "flat").enrichment_status, "succeeded");
  assert.equal((await readJson(b.env, row(b, "flat").enrichment_key)).mapped_frames, 3);
  assert.equal(row(b, "abs").enrichment_status, "succeeded");
  assert.equal(row(b, "nomatch").enrichment_status, "not_applicable");
  assert.equal(row(b, "ambiguous").enrichment_status, "failed");
  assert.equal((await readJson(b.env, row(b, "ambiguous").enrichment_key)).frames[0].reason, "ambiguous_debug_id");
});

test("same bundle filename with different build IDs never borrows another map or project", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  const otherId = "22345678-1234-4234-8234-123456789abc";
  await uploadSourceMap(request(map), b.env, project, id);
  await uploadSourceMap(request({ ...map, sources: ["second.js"] }), b.env, project, otherId);
  await event(b, "builds", { stacktrace: { frames: [frame(), frame({ debug_id: otherId })] } });
  await event(b, "other", { stacktrace: { frames: [frame()] } }, "2");
  await processEnrichment(b.env);
  const data = await readJson(b.env, row(b, "builds").enrichment_key);
  assert.deepEqual(data.frames.map(value => value.mapped.filename), ["original.js", "second.js"]);
  assert.equal(row(b, "other", "2").enrichment_status, "pending");
});

test("partial maps and invalid positions remain explicit rather than successful guesses", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  await uploadSourceMap(request(map), b.env, project, id);
  await event(b, "partial", { stacktrace: { frames: [frame(), frame({ debug_id: "22345678-1234-4234-8234-123456789abc" })] } });
  await event(b, "invalid", { stacktrace: { frames: [frame(), frame({ colno: 0 }), frame({ colno: undefined }), frame({ lineno: -1 }), frame({ lineno: 500 }), frame({ debug_id: id.replaceAll("-", "") })] } });
  await processEnrichment(b.env);
  const partial = await readJson(b.env, row(b, "partial").enrichment_key);
  assert.equal(row(b, "partial").enrichment_status, "pending");
  assert.equal(partial.mapped_frames, 1);
  assert.equal(partial.incomplete, true);
  const invalid = await readJson(b.env, row(b, "invalid").enrichment_key);
  assert.equal(row(b, "invalid").enrichment_status, "failed");
  assert.deepEqual(invalid.frames.slice(1).map(value => value.reason), ["invalid_position", "missing_column", "invalid_position", "unmapped_position", "invalid_debug_id"]);
});

test("bounded batches rotate missing maps fairly and record progress", async () => {
  const { processEnrichment } = await module();
  const b = bindings();
  for (let index = 0; index < 30; index++) await event(b, `event${String(index).padStart(2, "0")}`, { stacktrace: { frames: [frame()] } });
  await processEnrichment(b.env);
  assert.equal(b.sqlite.prepare("SELECT count(*) AS count FROM events WHERE enrichment_checked_at IS NOT NULL").get().count, 25);
  assert.equal(b.sqlite.prepare("SELECT processed FROM processing_state WHERE name='source_maps'").get().processed, 25);
  vi.advanceTimersByTime(60001);
  await processEnrichment(b.env);
  assert.equal(b.sqlite.prepare("SELECT count(*) AS count FROM events WHERE enrichment_checked_at IS NOT NULL").get().count, 30);
  assert.equal(b.sqlite.prepare("SELECT last_finished_at FROM processing_state").get().last_finished_at !== null, true);
});

test("storage failures are isolated, redacted, and retryable", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  await uploadSourceMap(request(map), b.env, project, id);
  const badKey = await event(b, "bad", { stacktrace: { frames: [frame()] } });
  const goodKey = await event(b, "good", { stacktrace: { frames: [frame()] } });
  const badBytes = b.blobs.get(badKey).slice();
  const goodBytes = b.blobs.get(goodKey).slice();
  const get = b.env.PAYLOADS.get;
  b.env.PAYLOADS.get = async key => { if (key === badKey) throw new Error("Bearer private-secret"); return get(key); };
  await processEnrichment(b.env);
  assert.equal(row(b, "bad").enrichment_status, "failed");
  assert.equal(row(b, "good").enrichment_status, "succeeded");
  assert.equal(row(b, "bad").enrichment_error, "Source map enrichment failed");
  assert.equal(b.sqlite.prepare("SELECT failed FROM processing_state").get().failed, 1);
  assert.deepEqual(b.blobs.get(badKey), badBytes);
  assert.deepEqual(b.blobs.get(goodKey), goodBytes);
  b.env.PAYLOADS.get = get;
  vi.advanceTimersByTime(60 * 60000 + 1);
  await processEnrichment(b.env);
  assert.equal(row(b, "bad").enrichment_status, "succeeded");
  assert.equal(row(b, "bad").enrichment_error, null);
});

test("concurrent enrichment is idempotent and a stale pending writer cannot overwrite success", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  const rawKey = await event(b, "event", { stacktrace: { frames: [frame()] } });
  const rawBytes = b.blobs.get(rawKey).slice();
  const put = b.env.PAYLOADS.put;
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  b.env.PAYLOADS.put = async (key, value, options) => {
    if (key.startsWith("enrichment/") && first) { first = false; entered(); await blocked; }
    return put(key, value, options);
  };
  const old = processEnrichment(b.env);
  await started;
  vi.advanceTimersByTime(5 * 60000 + 1);
  await uploadSourceMap(request(map), b.env, project, id);
  await Promise.all([processEnrichment(b.env), processEnrichment(b.env)]);
  const successKey = row(b, "event").enrichment_key;
  release();
  await old;
  assert.equal(row(b, "event").enrichment_status, "succeeded");
  assert.equal(row(b, "event").enrichment_key, successKey);
  assert.equal((await readJson(b.env, successKey)).status, "succeeded");
  assert.equal(b.sqlite.prepare("SELECT count(*) AS count FROM events").get().count, 1);
  assert.deepEqual(b.blobs.get(rawKey), rawBytes);
});

test("frame and context ceilings explicitly truncate derived evidence", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  await uploadSourceMap(request({ ...map, sourcesContent: ["before\n" + "x".repeat(300) + "\nafter"] }), b.env, project, id);
  await event(b, "large", { stacktrace: { frames: Array.from({ length: 1001 }, () => frame()) } });
  await processEnrichment(b.env);
  const data = await readJson(b.env, row(b, "large").enrichment_key);
  assert.equal(data.processed_frames, 1000);
  assert.equal(data.total_frames, 1001);
  assert.equal(data.truncated, true);
  assert.equal(data.incomplete, true);
  assert.equal(data.frames[0].context_truncated, true);
  assert.equal(data.frames[0].mapped.context_line.length, 256);
});

test("redacts before clipping source lines and flags absent embedded source context", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  await uploadSourceMap(request({ ...map, sourcesContent: ["before\n" + " ".repeat(252) + "Bearer private-secret\nafter"] }), b.env, project, id);
  await event(b, "clipped", { stacktrace: { frames: [frame()] } });
  const otherId = "22345678-1234-4234-8234-123456789abc";
  await uploadSourceMap(request({ ...map, sourcesContent: [null] }), b.env, project, otherId);
  await event(b, "absent", { stacktrace: { frames: [frame({ debug_id: otherId })] } });
  await processEnrichment(b.env);
  const clipped = await readJson(b.env, row(b, "clipped").enrichment_key);
  assert.equal(clipped.frames[0].context_truncated, true);
  assert.equal(clipped.frames[0].mapped.context_line, " ".repeat(252) + "Bear");
  const absent = await readJson(b.env, row(b, "absent").enrichment_key);
  assert.equal(absent.frames[0].context_missing, true);
  assert.equal(absent.incomplete, true);
  assert.equal(row(b, "absent").enrichment_status, "succeeded");
});

test("source context credential clipping does not leak a partial token", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  await uploadSourceMap(request({ ...map, sourcesContent: ["before\n" + "x".repeat(245) + " Bearer private-secret\nafter"] }), b.env, project, id);
  await event(b, "event", { stacktrace: { frames: [frame()] } });
  await processEnrichment(b.env);
  const data = await readJson(b.env, row(b, "event").enrichment_key);
  assert.equal(data.frames[0].mapped.context_line, ("x".repeat(245) + " Bearer [Filtered]").slice(0, 256));
});

test("catastrophic selection failures persist generic processing health and throw", async () => {
  const { processEnrichment } = await module();
  const b = bindings();
  await event(b, "candidate", { stacktrace: { frames: [frame()] } });
  const prepare = b.env.DB.prepare;
  b.env.DB.prepare = sql => {
    if (sql.startsWith("SELECT project_id,id,payload_key")) throw new Error("Bearer private-secret");
    return prepare(sql);
  };
  await assert.rejects(processEnrichment(b.env), /Source map processing failed/);
  const health = b.sqlite.prepare("SELECT * FROM processing_state WHERE name='source_maps'").get();
  assert.equal(health.error, "Source map processing failed");
  assert.notEqual(health.last_finished_at, null);
});

test("map cache is limited to five entries per event and does not survive between events", async () => {
  const { uploadSourceMap, processEnrichment } = await module();
  const b = bindings();
  const ids = Array.from({ length: 6 }, (_, index) => `${index + 1}2345678-1234-4234-8234-123456789abc`);
  for (const debugId of ids) await uploadSourceMap(request(map), b.env, project, debugId);
  await event(b, "a", { stacktrace: { frames: [...ids, ids[0]].map(debug_id => frame({ debug_id })) } });
  await event(b, "b", { stacktrace: { frames: [frame({ debug_id: ids[0] })] } });
  let reads = 0;
  const get = b.env.PAYLOADS.get;
  b.env.PAYLOADS.get = async key => { if (key.includes(`/source-maps/`) || key.startsWith("source-maps/")) reads++; return get(key); };
  await processEnrichment(b.env);
  assert.equal(reads, 8);
  assert.equal(row(b, "a").enrichment_status, "succeeded");
  assert.equal(row(b, "b").enrichment_status, "succeeded");
});

test("a source reference beyond the frame ceiling cannot be marked not applicable", async () => {
  const { processEnrichment } = await module();
  const b = bindings();
  await event(b, "event", { stacktrace: { frames: [...Array.from({ length: 1000 }, () => ({ filename: "native", lineno: 1 })), frame()] } });
  await processEnrichment(b.env);
  assert.equal(row(b, "event").enrichment_status, "failed");
  assert.equal((await readJson(b.env, row(b, "event").enrichment_key)).truncated, true);
});
