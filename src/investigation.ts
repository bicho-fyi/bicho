import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { HttpError } from "./http.ts";
import type { Env, Project } from "./core.ts";

type Filters = { from: string | null; to: string | null; q: string | null; environment: string | null; release: string | null; level: string | null; issue_id: string | null; status: string | null; tags: [string, string][] };
type Cursor = { v: number; endpoint: string; project: string; fingerprint: string; snapshot: number; position: string | number; id: string };
const statuses = ["unresolved", "resolved", "ignored", "muted"];
const columns = "e.id, e.issue_id, e.timestamp, e.received_at, e.level, e.environment, e.release, e.message, e.type, e.enrichment_status, e.enrichment_checked_at";

function invalid(field: string): never { throw new HttpError(400, `Invalid ${field}`); }
function integer(url: URL, key: string, fallback: number, maximum: number): number {
  if (url.searchParams.getAll(key).length > 1) invalid(key);
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > maximum || (key === "limit" && Number(value) === 0)) invalid(key);
  return Number(value);
}
function datetime(value: string | null, field: string): string | null {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/.exec(value);
  if (!match) invalid(field);
  const canonical = `${match[1]}.${(match[2] ?? "").replace(/0+$/, "").padEnd(3, "0")}Z`;
  const date = new Date(canonical);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== match[1]) invalid(field);
  return canonical;
}
function filters(url: URL, issues = false): Filters {
  const get = (field: string) => {
    const values = url.searchParams.getAll(field);
    if (values.length > 1 || (values[0]?.length ?? 0) > 512) invalid(field);
    return values[0] ?? null;
  };
  const from = datetime(get("from"), "from");
  const to = datetime(get("to"), "to");
  if (from && to && from.slice(0, -1) >= to.slice(0, -1)) invalid("time range");
  const status = get("status") ?? (issues ? "unresolved" : null);
  if (status !== null && status !== "all" && !statuses.includes(status)) invalid("status");
  const issue_id = get("issue_id");
  if (issue_id !== null && !/^[a-f0-9]{64}$/.test(issue_id)) invalid("issue_id");
  const tags: [string, string][] = [];
  for (const [key, value] of url.searchParams) {
    if (!key.startsWith("tag.")) continue;
    if (key.length <= 4 || key.length > 132 || value.length > 512 || tags.length === 16) invalid("tag filter");
    tags.push([key.slice(4), value]);
  }
  tags.sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1);
  return { from, to, q: get("q"), environment: get("environment"), release: get("release"), level: get("level"), issue_id, status, tags };
}
function where(project: Project, f: Filters, snapshot: number, issues = false) {
  const conditions = ["e.project_id = ?", "e.rowid <= ?"];
  const args: (string | number)[] = [project.id, snapshot];
  if (f.from) { conditions.push("rtrim(e.timestamp, 'Z') >= ?"); args.push(f.from.slice(0, -1)); }
  if (f.to) { conditions.push("rtrim(e.timestamp, 'Z') < ?"); args.push(f.to.slice(0, -1)); }
  for (const key of ["environment", "release", "level", "issue_id"] as const) {
    if (f[key] !== null) { conditions.push(`e.${key} = ?`); args.push(f[key]); }
  }
  if (f.q) { conditions.push(`instr(lower(${issues ? "i.title" : "e.message"}), lower(?)) > 0`); args.push(f.q); }
  if (f.status && f.status !== "all") {
    conditions.push(issues ? "i.status = ?" : "EXISTS (SELECT 1 FROM issues i WHERE i.project_id = e.project_id AND i.id = e.issue_id AND i.status = ?)");
    args.push(f.status);
  }
  for (const [key, value] of f.tags) {
    conditions.push("EXISTS (SELECT 1 FROM event_tags t WHERE t.project_id = e.project_id AND t.event_id = e.id AND t.key = ? AND t.value = ?)");
    args.push(key, value);
  }
  return { sql: conditions.join(" AND "), args };
}
function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
async function pagination(url: URL, env: Env, project: Project, endpoint: string, f: Filters) {
  const limit = integer(url, "limit", 50, 100);
  const offset = integer(url, "offset", 0, 1000000);
  const fingerprint = createHash("sha256").update(JSON.stringify(f)).digest("hex");
  const value = url.searchParams.get("cursor");
  if (url.searchParams.getAll("cursor").length > 1) invalid("cursor");
  let cursor: Cursor | null = null;
  if (value !== null) {
    if (offset || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) invalid("cursor");
    try {
      cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
      if (!cursor || Object.keys(cursor).join(",") !== "v,endpoint,project,fingerprint,snapshot,position,id" || encode(cursor) !== value || cursor.v !== 1 || cursor.endpoint !== endpoint || cursor.project !== project.id || cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.snapshot) || cursor.snapshot < 0 || typeof cursor.id !== "string") invalid("cursor");
      if (endpoint.startsWith("history:")) {
        if (!Number.isSafeInteger(cursor.position) || Number(cursor.position) < 1 || Number(cursor.position) > cursor.snapshot || cursor.id !== "") invalid("cursor");
      } else if (typeof cursor.position !== "string" || datetime(cursor.position, "cursor") !== cursor.position || !new RegExp(endpoint === "issues" ? "^[a-f0-9]{64}$" : "^[a-f0-9]{32}$").test(cursor.id)) invalid("cursor");
    } catch { invalid("cursor"); }
  }
  const table = endpoint.startsWith("history:") ? "issue_history" : "events";
  const maximum = await env.DB.prepare(`SELECT coalesce(max(${table === "events" ? "rowid" : "id"}), 0) AS maximum FROM ${table} WHERE project_id = ?`).bind(project.id).first<{ maximum: number }>();
  if (cursor && cursor.snapshot > maximum!.maximum) invalid("cursor");
  return { limit, offset, cursor, snapshot: cursor?.snapshot ?? maximum!.maximum, fingerprint, endpoint, project: project.id };
}
function provenance(f: Filters, snapshot: number, statusLive = false) {
  return { generated_at: new Date().toISOString(), filters: f, snapshot_rowid: snapshot, occurrence_time: "timestamp", ingestion_time: "received_at", status_consistency: statusLive ? "live; status changes can alter later pages" : "not filtered", snapshot_scope: "event membership and ordering; issue event_count is live and all-time" };
}
function page(rows: Record<string, unknown>[], p: Awaited<ReturnType<typeof pagination>>, position: string, history = false) {
  const items = rows.slice(0, p.limit);
  const last = items.at(-1);
  const more = rows.length > p.limit;
  return { items, has_more: more, next_offset: more && !p.cursor ? p.offset + p.limit : null, next_cursor: more && last ? encode({ v: 1, endpoint: p.endpoint, project: p.project, fingerprint: p.fingerprint, snapshot: p.snapshot, position: last[position] as string | number, id: history ? "" : last.id as string }) : null };
}

export async function searchEvents(url: URL, env: Env, project: Project): Promise<Response> {
  const f = filters(url);
  const p = await pagination(url, env, project, "events", f);
  const w = where(project, f, p.snapshot);
  const after = p.cursor ? "AND (e.received_at < ? OR (e.received_at = ? AND e.id > ?))" : "";
  const args = p.cursor ? [p.cursor.position, p.cursor.position, p.cursor.id] : [];
  const result = await env.DB.prepare(`SELECT ${columns} FROM events e WHERE ${w.sql} ${after} ORDER BY e.received_at DESC, e.id ASC LIMIT ? OFFSET ?`)
    .bind(...w.args, ...args, p.limit + 1, p.offset).all<Record<string, unknown>>();
  const output = page(result.results, p, "received_at");
  return Response.json({ events: output.items, has_more: output.has_more, next_offset: output.next_offset, next_cursor: output.next_cursor, provenance: provenance(f, p.snapshot, f.status !== null && f.status !== "all") });
}

export async function issueHistory(url: URL, env: Env, project: Project, id: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(id)) invalid("issue ID");
  const issue = await env.DB.prepare("SELECT id FROM issues WHERE project_id = ? AND id = ?").bind(project.id, id).first();
  if (!issue) throw new HttpError(404, "Issue not found");
  const f = filters(url);
  if (f.q !== null || f.environment !== null || f.release !== null || f.level !== null || f.issue_id !== null || f.status !== null || f.tags.length) invalid("history filters");
  const p = await pagination(url, env, project, `history:${id}`, f);
  const conditions = ["project_id = ?", "issue_id = ?", "id <= ?"];
  const args: (string | number)[] = [project.id, id, p.snapshot];
  if (f.from) { conditions.push("rtrim(changed_at, 'Z') >= ?"); args.push(f.from.slice(0, -1)); }
  if (f.to) { conditions.push("rtrim(changed_at, 'Z') < ?"); args.push(f.to.slice(0, -1)); }
  if (p.cursor) { conditions.push("id < ?"); args.push(p.cursor.position); }
  const result = await env.DB.prepare(`SELECT id, issue_id, from_status, to_status, changed_at, actor FROM issue_history WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...args, p.limit + 1, p.offset).all<Record<string, unknown>>();
  const output = page(result.results, p, "id", true);
  return Response.json({ history: output.items, has_more: output.has_more, next_offset: output.next_offset, next_cursor: output.next_cursor, provenance: { generated_at: new Date().toISOString(), filters: f, snapshot_history_id: p.snapshot, time_field: "changed_at", order: "id DESC" } });
}

export async function eventStats(url: URL, env: Env, project: Project): Promise<Response> {
  const f = filters(url);
  if (url.searchParams.has("cursor") || url.searchParams.has("offset") || url.searchParams.has("limit")) invalid("stats pagination");
  f.to ??= new Date().toISOString();
  f.from ??= new Date(Date.parse(f.to) - 86400000).toISOString();
  const duration = Date.parse(f.to) - Date.parse(f.from);
  const bucket = url.searchParams.get("bucket") ?? "hour";
  if (!(bucket === "hour" || bucket === "day") || duration <= 0 || duration > 90 * 86400000) invalid("stats range or bucket");
  const interval = bucket === "hour" ? 3600000 : 86400000;
  if (Math.ceil(Date.parse(f.to) / interval) - Math.floor(Date.parse(f.from) / interval) > 2160) invalid("bucket count");
  const p = await pagination(url, env, project, "stats", f);
  const w = where(project, f, p.snapshot);
  const total = where(project, { ...f, q: null, environment: null, release: null, level: null, issue_id: null, status: null, tags: [] }, p.snapshot);
  const base = `FROM events e WHERE ${w.sql}`;
  const format = bucket === "hour" ? "%Y-%m-%dT%H:00:00.000Z" : "%Y-%m-%dT00:00:00.000Z";
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT count(*) AS total_count FROM events e WHERE ${total.sql}`).bind(...total.args),
    env.DB.prepare(`SELECT count(*) AS matching_count, count(DISTINCT e.issue_id) AS unique_issues ${base}`).bind(...w.args),
    env.DB.prepare(`SELECT strftime('${format}', e.timestamp) AS bucket, count(*) AS count ${base} GROUP BY bucket ORDER BY bucket ASC LIMIT 2160`).bind(...w.args),
    ...["release", "environment", "level"].map(field => env.DB.prepare(`SELECT e.${field} AS value, count(*) AS count ${base} GROUP BY e.${field} ORDER BY count DESC, value ASC LIMIT 21`).bind(...w.args)),
    env.DB.prepare(`SELECT ${columns} ${base} ORDER BY e.received_at DESC, e.id ASC LIMIT 5`).bind(...w.args),
  ]);
  const matching = results[1]!.results[0] as { matching_count: number; unique_issues: number };
  const breakdowns = Object.fromEntries(["release", "environment", "level"].map((field, index) => {
    const rows = results[index + 3]!.results as { value: string | null; count: number }[];
    const values = rows.slice(0, 20);
    return [field, { values, other_count: matching.matching_count - values.reduce((sum, row) => sum + row.count, 0), has_more: rows.length > 20 }];
  }));
  return Response.json({ ...(results[0]!.results[0] as { total_count: number }), ...matching, bucket, buckets: results[2]!.results, breakdowns, representative_events: results[6]!.results,
    provenance: { ...provenance(f, p.snapshot, f.status !== null && f.status !== "all"), total_scope: "project events within occurrence-time range, before other filters", bucket_timezone: "UTC", empty_buckets: "omitted", representative_order: "received_at DESC, id ASC" } });
}

export async function processingHealth(env: Env, project: Project): Promise<Response> {
  const results = await env.DB.batch([
    env.DB.prepare("SELECT enrichment_status, count(*) AS count FROM events WHERE project_id = ? GROUP BY enrichment_status").bind(project.id),
    env.DB.prepare("SELECT count(*) AS count FROM source_maps WHERE project_id = ?").bind(project.id),
    env.DB.prepare("SELECT name, last_started_at, last_finished_at, processed, failed, error IS NOT NULL AS has_error FROM processing_state WHERE name = 'source_maps'"),
  ]);
  const counts = { pending: 0, failed: 0, succeeded: 0, not_applicable: 0 };
  for (const row of results[0]!.results as { enrichment_status: keyof typeof counts; count: number }[]) counts[row.enrichment_status] = row.count;
  const state = results[2]!.results[0] as { name: string; last_started_at: string | null; last_finished_at: string | null; processed: number; failed: number; has_error: number } | undefined;
  return Response.json({ project_id: project.id, enrichment: { scope: "project", counts }, source_maps: { scope: "project", count: (results[1]!.results[0] as { count: number }).count },
    processing_state: { scope: "global", source_maps: state ? { ...state, has_error: Boolean(state.has_error) } : null }, provenance: { generated_at: new Date().toISOString(), error_details: "omitted to avoid exposing credentials or storage keys" } });
}

export async function listInvestigationIssues(url: URL, env: Env, project: Project): Promise<Response> {
  const f = filters(url, true);
  const p = await pagination(url, env, project, "issues", f);
  const w = where(project, f, p.snapshot, true);
  const after = p.cursor ? "WHERE snapshot_last_seen < ? OR (snapshot_last_seen = ? AND id > ?)" : "";
  const args = p.cursor ? [p.cursor.position, p.cursor.position, p.cursor.id] : [];
  const result = await env.DB.prepare(`WITH matched AS (
    SELECT i.*, count(*) AS matched_count, max(e.timestamp) AS snapshot_last_seen
    FROM events e JOIN issues i ON i.project_id = e.project_id AND i.id = e.issue_id
    WHERE ${w.sql} GROUP BY i.project_id, i.id)
    SELECT * FROM matched ${after} ORDER BY snapshot_last_seen DESC, id ASC LIMIT ? OFFSET ?`)
    .bind(...w.args, ...args, p.limit + 1, p.offset).all<Record<string, unknown>>();
  const output = page(result.results, p, "snapshot_last_seen");
  return Response.json({ issues: output.items, has_more: output.has_more, next_offset: output.next_offset, next_cursor: output.next_cursor, provenance: provenance(f, p.snapshot, true) });
}
