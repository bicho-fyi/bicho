import assert from "node:assert/strict";
import { test } from "vitest";
import { bindings } from "./helpers.js";

const project = { id: "1" };
const issueA = "a".repeat(64);
const issueB = "b".repeat(64);
const url = query => new URL(`https://bicho.test/api/1/events?${query}`);
const api = () => import("../src/investigation.ts");
function add(f, number, issue = issueA, fields = {}) {
  const row = { project_id: "1", timestamp: "2026-10-01T10:00:00.000Z", received_at: "2026-10-01T10:00:00.000Z", environment: "prod", release: "v1", level: "error", message: "failure", enrichment_status: "not_applicable", ...fields };
  const id = number.toString(16).padStart(32, "0");
  f.sqlite.prepare("INSERT INTO issues (project_id,id,title,type,first_seen,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING").run(row.project_id, issue, "Error: failure", "Error", row.timestamp, row.timestamp);
  f.sqlite.prepare("INSERT INTO events (project_id,id,issue_id,timestamp,received_at,environment,release,level,message,enrichment_status,payload_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(row.project_id, id, issue, row.timestamp, row.received_at, row.environment, row.release, row.level, row.message, row.enrichment_status, "private-key");
  return id;
}
function tag(f, id, key, value) { f.sqlite.prepare("INSERT INTO event_tags VALUES (?,?,?,?)").run("1", id, key, value); }

test("event pages have project/filter-bound cursors and exclude concurrent backdated inserts", async () => {
  const { searchEvents } = await api();
  const f = bindings();
  add(f, 1);
  add(f, 2);
  add(f, 3, issueA, { project_id: "2" });
  const first = await (await searchEvents(url("limit=1&q=failure"), f.env, project)).json();
  assert.equal(first.events[0].id, "1".padStart(32, "0"));
  assert.ok(first.next_cursor);
  add(f, 4, issueA, { received_at: "2026-09-01T00:00:00.000Z" });
  const second = await (await searchEvents(url(`limit=1&q=failure&cursor=${first.next_cursor}`), f.env, project)).json();
  assert.deepEqual(second.events.map(e => e.id), ["2".padStart(32, "0")]);
  assert.equal(second.next_cursor, null);
  assert.equal(JSON.stringify(first).includes("private-key"), false);
  for (const query of ["q=other", "q=failure&offset=1"]) {
    await assert.rejects(searchEvents(url(`${query}&cursor=${first.next_cursor}`), f.env, project), { status: 400 });
  }
  await assert.rejects(searchEvents(url(`q=failure&cursor=${first.next_cursor}`), f.env, { id: "2" }), { status: 400 });
  await assert.rejects(searchEvents(url(`q=failure&cursor=${first.next_cursor}=`), f.env, project), { status: 400 });
});

test("all investigation pages explicitly report remaining cursor results", async () => {
  const { searchEvents, listInvestigationIssues, issueHistory } = await api();
  const f = bindings();
  try {
    for (let n = 1; n <= 3; n++) add(f, n, n.toString(16).repeat(64));
    add(f, 4);
    for (const status of ["resolved", "muted", "unresolved"]) {
      f.sqlite.prepare("UPDATE issues SET status=? WHERE project_id='1' AND id=?").run(status, issueA);
    }
    for (const read of [
      query => searchEvents(url(query), f.env, project),
      query => listInvestigationIssues(url(query), f.env, project),
      query => issueHistory(url(query), f.env, project, issueA),
    ]) {
      const first = await (await read("limit=1")).json();
      assert.equal(first.has_more, true);
      assert.equal(first.next_offset, 1);
      const second = await (await read(`limit=1&cursor=${first.next_cursor}`)).json();
      assert.equal(second.has_more, true);
      assert.ok(second.next_cursor);
      assert.equal(second.next_offset, null);
      const last = await (await read("limit=100")).json();
      assert.equal(last.has_more, false);
      assert.equal(last.next_cursor, null);
    }
  } finally { f.sqlite.close(); }
});

test("event ranges use occurrence time and reject malformed trust-boundary inputs", async () => {
  const { searchEvents } = await api();
  const f = bindings();
  add(f, 1);
  add(f, 2, issueA, { timestamp: "2026-10-01T11:00:00.000Z" });
  const result = await (await searchEvents(url("from=2026-10-01T10:00:00Z&to=2026-10-01T11:00:00Z"), f.env, project)).json();
  assert.equal(result.events.length, 1);
  for (const query of ["from=2026-02-30T10:00:00Z", "to=2026-10-01", "from=2026-10-01T24:00:00Z", "from=2026-10-01T10:00:00Z&to=2026-10-01T09:00:00Z", "issue_id=broken", "limit=0", "limit=101", "offset=1000001", `q=${"x".repeat(513)}`, "tag.=x", `tag.${"x".repeat(129)}=x`, `tag.a=${"x".repeat(513)}`, Array.from({ length: 17 }, (_, i) => `tag.k${i}=v`).join("&"), "cursor=e30", "cursor=" + "a".repeat(2049)]) {
    await assert.rejects(searchEvents(url(query), f.env, project), { status: 400 }, query);
  }
});

test("issue pages order by immutable snapshot events rather than live last_seen", async () => {
  const { listInvestigationIssues } = await api();
  const f = bindings();
  add(f, 1, issueA, { timestamp: "2026-10-01T11:00:00.000Z" });
  add(f, 2, issueB);
  const first = await (await listInvestigationIssues(url("limit=1"), f.env, project)).json();
  add(f, 3, issueB, { timestamp: "2026-10-02T00:00:00.000Z" });
  const second = await (await listInvestigationIssues(url(`limit=1&cursor=${first.next_cursor}`), f.env, project)).json();
  assert.equal(second.issues[0].id, issueB);
  assert.equal(second.issues[0].event_count, 2);
  assert.equal(second.issues[0].matched_count, 1);
  assert.equal(second.issues[0].snapshot_last_seen, "2026-10-01T10:00:00.000Z");
});

test("history is project-scoped, no-op state changes add nothing, and cursor pages freeze membership", async () => {
  const { issueHistory } = await api();
  const f = bindings();
  add(f, 1);
  const change = status => f.sqlite.prepare("UPDATE issues SET status=? WHERE project_id='1' AND id=?").run(status, issueA);
  change("unresolved");
  change("resolved");
  change("resolved");
  change("muted");
  const first = await (await issueHistory(url("limit=1"), f.env, project, issueA)).json();
  assert.equal(first.history[0].to_status, "muted");
  change("unresolved");
  const second = await (await issueHistory(url(`limit=1&cursor=${first.next_cursor}`), f.env, project, issueA)).json();
  assert.equal(second.history[0].to_status, "resolved");
  assert.equal(second.next_cursor, null);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM events").get().n, 1);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM issue_history").get().n, 3);
  await assert.rejects(issueHistory(url(""), f.env, { id: "2" }, issueA), { status: 404 });
  await assert.rejects(issueHistory(url(""), f.env, project, "bad"), { status: 400 });
  add(f, 2, issueB);
  await assert.rejects(issueHistory(url(`cursor=${first.next_cursor}`), f.env, project, issueB), { status: 400 });
  await assert.rejects((await api()).searchEvents(url(`cursor=${first.next_cursor}`), f.env, project), { status: 400 });
});

test("stats return real UTC buckets, bounded breakdowns, and deterministic representative metadata", async () => {
  const { eventStats } = await api();
  const f = bindings();
  add(f, 1);
  add(f, 2, issueA, { environment: "dev", release: "v2", timestamp: "2026-10-01T11:00:00.000Z" });
  add(f, 3, issueB, { environment: "dev", release: "v2", level: "warning", timestamp: "2026-10-01T11:30:00.000Z" });
  add(f, 4, issueA, { project_id: "2" });
  const query = "from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z";
  const result = await (await eventStats(url(query), f.env, project)).json();
  assert.equal(result.total_count, 3);
  assert.equal(result.matching_count, 3);
  assert.equal(result.unique_issues, 2);
  assert.deepEqual(result.buckets, [{ bucket: "2026-10-01T10:00:00.000Z", count: 1 }, { bucket: "2026-10-01T11:00:00.000Z", count: 2 }]);
  assert.deepEqual(result.breakdowns.release, { values: [{ value: "v2", count: 2 }, { value: "v1", count: 1 }], other_count: 0, has_more: false });
  assert.deepEqual(result.representative_events.map(e => e.id), [1, 2, 3].map(n => n.toString(16).padStart(32, "0")));
  const filtered = await (await eventStats(url(query + "&environment=dev&level=error"), f.env, project)).json();
  assert.equal(filtered.total_count, 3);
  assert.equal(filtered.matching_count, 1);
  assert.equal(filtered.unique_issues, 1);
  assert.deepEqual((await (await eventStats(url(query + "&q=absent"), f.env, project)).json()).buckets, []);
  for (let n = 5; n <= 26; n++) add(f, n, issueA, { release: `r${n}` });
  const bounded = await (await eventStats(url(query), f.env, project)).json();
  assert.equal(bounded.breakdowns.release.values.length, 20);
  assert.equal(bounded.breakdowns.release.has_more, true);
  assert.equal(bounded.breakdowns.release.other_count, 4);
  assert.equal(bounded.representative_events.length, 5);
  for (const q of ["from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z", query + "&bucket=week"]) await assert.rejects(eventStats(url(q), f.env, project), { status: 400 });
  const defaults = await (await eventStats(url(""), f.env, project)).json();
  assert.equal(Date.parse(defaults.provenance.filters.to) - Date.parse(defaults.provenance.filters.from), 86400000);
});

test("processing health separates project counts from global processor state without exposing errors or keys", async () => {
  const { processingHealth } = await api();
  const f = bindings();
  for (const [index, status] of ["pending", "failed", "succeeded", "not_applicable"].entries()) add(f, index + 1, issueA, { enrichment_status: status });
  add(f, 5, issueA, { project_id: "2", enrichment_status: "failed" });
  f.sqlite.prepare("INSERT INTO source_maps VALUES (?,?,?,?,?)").run("1", "debug", "private-source-key", "checksum", "2026-10-01T00:00:00.000Z");
  f.sqlite.prepare("INSERT INTO processing_state (name,processed,failed,error) VALUES (?,?,?,?)").run("source_maps", 10, 2, "Bearer SECRET https://key:secret@example.test/1 private-source-key");
  const result = await (await processingHealth(f.env, project)).json();
  assert.deepEqual(result.enrichment, { scope: "project", counts: { pending: 1, failed: 1, succeeded: 1, not_applicable: 1 } });
  assert.equal(result.source_maps.count, 1);
  assert.equal(result.processing_state.scope, "global");
  assert.equal(result.processing_state.source_maps.processed, 10);
  assert.equal(result.processing_state.source_maps.has_error, true);
  assert.equal(/SECRET|private-source-key|key:secret/.test(JSON.stringify(result)), false);
  const other = await (await processingHealth(f.env, { id: "2" })).json();
  assert.equal(other.enrichment.counts.failed, 1);
  assert.equal(other.enrichment.counts.pending, 0);
  assert.equal(other.source_maps.count, 0);
});

test("RFC3339 fractions preserve submillisecond range boundaries and reject equivalent endpoints", async () => {
  const { searchEvents } = await api();
  const f = bindings();
  add(f, 1);
  const included = await (await searchEvents(url("to=2026-10-01T10:00:00.0000000001Z"), f.env, project)).json();
  assert.equal(included.events.length, 1);
  const excluded = await (await searchEvents(url("from=2026-10-01T10:00:00.0000000001Z"), f.env, project)).json();
  assert.equal(excluded.events.length, 0);
  await assert.rejects(searchEvents(url("from=2026-10-01T10:00:00.100Z&to=2026-10-01T10:00:00.1000Z"), f.env, project), { status: 400 });
  await assert.rejects(searchEvents(url("limit=1&limit=2"), f.env, project), { status: 400 });
});

test("message search and multiple tag predicates are tied to one project event", async () => {
  const { searchEvents } = await api();
  const f = bindings();
  const a = add(f, 1, issueA, { message: "database timeout" });
  tag(f, a, "region", "eu");
  tag(f, a, "tier", "free");
  const b = add(f, 2, issueA, { message: "socket timeout" });
  tag(f, b, "region", "us");
  tag(f, b, "tier", "paid");
  const c = add(f, 3, issueB, { message: "database timeout" });
  tag(f, c, "region", "eu");
  tag(f, c, "tier", "paid");
  const result = await (await searchEvents(url("q=database&tag.region=eu&tag.tier=paid"), f.env, project)).json();
  assert.deepEqual(result.events.map(e => e.id), [c]);
  assert.deepEqual((await (await searchEvents(url("q=failure"), f.env, project)).json()).events, []);
  assert.deepEqual((await (await searchEvents(url(`issue_id=${issueA}&tag.region=eu&tag.tier=paid`), f.env, project)).json()).events, []);
});

test("day stats expose only actual buckets and report source-map state as absent when not run", async () => {
  const { eventStats, processingHealth } = await api();
  const f = bindings();
  add(f, 1);
  const result = await (await eventStats(url("from=2026-10-01T00:00:00Z&to=2026-10-03T00:00:00Z&bucket=day"), f.env, project)).json();
  assert.deepEqual(result.buckets, [{ bucket: "2026-10-01T00:00:00.000Z", count: 1 }]);
  assert.equal((await (await processingHealth(f.env, project)).json()).processing_state.source_maps, null);
});

test("issue filters and tags match one event and keep all-time counts", async () => {
  const { listInvestigationIssues } = await api();
  const f = bindings();
  const a = add(f, 1, issueA, { environment: "prod", release: "v1" });
  tag(f, a, "region", "eu");
  const b = add(f, 2, issueA, { environment: "dev", release: "v2" });
  tag(f, b, "region", "us");
  const c = add(f, 3, issueB, { environment: "prod", release: "v2" });
  tag(f, c, "region", "eu");
  const result = await (await listInvestigationIssues(url("environment=prod&release=v2&tag.region=eu"), f.env, project)).json();
  assert.deepEqual(result.issues.map(i => i.id), [issueB]);
  const matched = await (await listInvestigationIssues(url("tag.region=eu"), f.env, project)).json();
  assert.equal(matched.issues.find(i => i.id === issueA).event_count, 2);
  assert.equal(matched.issues.find(i => i.id === issueA).matched_count, 1);
});
