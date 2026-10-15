import { randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError, object, type JsonObject } from "./http.ts";
import { readBody as body, readJson, putJson, redact, boundedEvidence } from "./payload.ts";
import { searchEvents } from "./investigation.ts";
export { listInvestigationIssues as listIssues } from "./investigation.ts";

export type Env = { DB: D1Database; PAYLOADS: R2Bucket; BICHO_ADMIN_TOKEN?: string; CORS_ORIGINS?: string };
export type Project = { id: string; public_key: string; secret_hash: string | null; hourly_limit: number };
const encoder = new TextEncoder();


export async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function matches(value: string, expectedHash: string): Promise<boolean> {
  return timingSafeEqual(encoder.encode(await hash(value)), encoder.encode(expectedHash));
}

export async function authenticateAdmin(request: Request, env: Env): Promise<void> {
  if (!env.BICHO_ADMIN_TOKEN) throw new HttpError(503, "Admin authentication is not configured");
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ") || !await matches(auth.slice(7), await hash(env.BICHO_ADMIN_TOKEN))) {
    throw new HttpError(401, "Invalid admin token");
  }
}

function text(value: unknown, max = 512): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new HttpError(400, "Invalid string field");
  return value;
}



export async function prepareEvent(event: JsonObject, headers: JsonObject) {
  event = object(redact(event));
  const rawId = event.event_id ?? headers.event_id ?? crypto.randomUUID().replaceAll("-", "");
  if (typeof rawId !== "string" || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(rawId)) {
    throw new HttpError(400, "Invalid event ID");
  }
  if (event.event_id !== undefined && headers.event_id !== undefined && event.event_id !== headers.event_id) {
    throw new HttpError(400, "Conflicting event IDs");
  }
  const id = rawId.replaceAll("-", "").toLowerCase();
  const values = Array.isArray(event.exception) ? event.exception : event.exception == null ? [] : object(event.exception).values;
  if (values !== undefined && !Array.isArray(values)) throw new HttpError(400, "Invalid exceptions");
  const exception = Array.isArray(values) && values.length ? object(values.at(-1)) : {};
  const type = text(exception.type) ?? "Error";
  const logentry = event.logentry === undefined ? {} : object(event.logentry);
  const rawMessage = event.message !== null && typeof event.message === "object" ? object(event.message) : { message: event.message };
  const message = text(exception.value, 16384) ?? text(rawMessage.formatted, 16384) ?? text(rawMessage.message, 16384) ?? text(logentry.formatted, 16384) ?? text(logentry.message, 16384) ?? "Unknown error";
  const stack = exception.stacktrace ?? event.stacktrace;
  const frames = stack === undefined ? [] : object(stack).frames;
  if (frames !== undefined && !Array.isArray(frames)) throw new HttpError(400, "Invalid stack frames");
  const frame = Array.isArray(frames) && frames.length ? object(frames.at(-1)) : {};
  let fingerprint = await hash(JSON.stringify([type, message, text(frame.filename, 4096), text(frame.function), frame.lineno ?? null]));
  if (event.fingerprint !== undefined) {
    const parts = event.fingerprint;
    if (!Array.isArray(parts) || !parts.every((part: unknown): part is string => typeof part === "string")) {
      throw new HttpError(400, "Fingerprint must be an array of strings");
    }
    if (parts.length && !(parts.length === 1 && parts[0] === "{{ default }}")) {
      fingerprint = await hash(JSON.stringify(["fingerprint", parts.map(part => part === "{{ default }}" ? fingerprint : part)]));
    }
  }
  const received = new Date().toISOString();
  let timestamp = received;
  if (event.timestamp !== undefined) {
    if (typeof event.timestamp !== "string" && typeof event.timestamp !== "number") throw new HttpError(400, "Invalid timestamp");
    const date = new Date(typeof event.timestamp === "number" ? event.timestamp * 1000 : event.timestamp);
    if (!Number.isFinite(date.getTime())) throw new HttpError(400, "Invalid timestamp");
    if (typeof event.timestamp === "string" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) ||
      new Date(event.timestamp.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) !== event.timestamp.slice(0, 10))) throw new HttpError(400, "Invalid timestamp");
    if (date.toISOString().length !== 24) throw new HttpError(400, "Timestamp year is out of range");
    timestamp = date.toISOString();
  }
  const level = text(event.level) ?? "error";
  if (!["fatal", "error", "warning", "info", "debug", "log"].includes(level)) throw new HttpError(400, "Invalid level");
  const tags = event.tags === undefined ? [] : Array.isArray(event.tags) ? event.tags : Object.entries(object(event.tags));
  if (tags.length > 100) throw new HttpError(400, "Too many tags");
  const indexedTags = new Map<string, string>();
  for (const pair of tags) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !pair[0] || pair[0].length > 128 ||
        !["string", "number", "boolean"].includes(typeof pair[1]) || String(pair[1]).length > 512) throw new HttpError(400, "Invalid tags");
    indexedTags.set(pair[0], String(pair[1]));
  }
  const hasDebugId = (value: unknown): boolean => Array.isArray(value) ? value.some(hasDebugId) :
    value !== null && typeof value === "object" && (typeof (value as JsonObject).debug_id === "string" || Object.values(value).some(hasDebugId));
  return { id, fingerprint, type, message, tags: indexedTags, enrichment: hasDebugId(event) ? "pending" : "not_applicable",
    title: `${type}: ${message}`.slice(0, 512), timestamp, received, level,
    environment: text(event.environment), release: text(event.release), payload: { ...event, event_id: id } };
}

function quotaError(received: string): HttpError {
  const next = new Date(received);
  next.setUTCMinutes(60, 0, 0);
  const retry = Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000));
  return new HttpError(429, "Project hourly ingest quota exceeded", { "Retry-After": String(retry) });
}


export async function persistEvent(env: Env, project: Project, event: Awaited<ReturnType<typeof prepareEvent>>): Promise<void> {
    const duplicate = await env.DB.prepare("SELECT id FROM events WHERE project_id = ? AND id = ?").bind(project.id, event.id).first();
    if (duplicate) return;
    const usage = await env.DB.prepare("SELECT count(*) AS count FROM events WHERE project_id = ? AND received_at >= ? AND received_at < strftime('%Y-%m-%dT%H:00:00.000Z', ?, '+1 hour')")
      .bind(project.id, event.received.slice(0, 13) + ":00:00.000Z", event.received).first<{ count: number }>();
    if ((usage?.count ?? 0) >= project.hourly_limit) {
      if (await env.DB.prepare("SELECT id FROM events WHERE project_id = ? AND id = ?").bind(project.id, event.id).first()) return;
      throw quotaError(event.received);
    }
    const key = `${project.id}/${event.id}/${crypto.randomUUID()}.json`;
    await putJson(env, key, event.payload);
    let results;
    try { results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO issues (project_id, id, title, type, first_seen, last_seen)
        SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE project_id = ? AND id = ?)
        ON CONFLICT(project_id, id) DO NOTHING`).bind(project.id, event.fingerprint, event.title, event.type, event.timestamp, event.timestamp, project.id, event.id),
      env.DB.prepare(`INSERT INTO events (project_id, id, issue_id, timestamp, received_at, level, environment, release, payload_key, message, type, enrichment_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO NOTHING RETURNING id`)
        .bind(project.id, event.id, event.fingerprint, event.timestamp, event.received, event.level, event.environment, event.release, key, event.message, event.type, event.enrichment),
      ...Array.from(event.tags, ([tag, value]) => env.DB.prepare(`INSERT INTO event_tags (project_id, event_id, key, value)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE project_id = ? AND id = ? AND payload_key = ?)
        ON CONFLICT(project_id, event_id, key) DO NOTHING`).bind(project.id, event.id, tag, value, project.id, event.id, key)),
    ]); } catch (error) {
      if (error instanceof Error && error.message.includes("ingest_quota_exceeded")) {
        await env.PAYLOADS.delete(key);
        throw quotaError(event.received);
      }
      throw error;
    }
    if (!results[1]?.results.length) await env.PAYLOADS.delete(key);
}

function integer(url: URL, key: string, fallback: number, maximum: number): number {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > maximum || (key === "limit" && Number(value) === 0)) throw new HttpError(400, `Invalid ${key}`);
  return Number(value);
}

export async function createProject(request: Request, env: Env): Promise<Response> {
  const bytes = await body(request, 4096);
  let input: JsonObject;
  try {
    input = object(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const name = text(input.name)?.trim();
  const hourlyLimit = input.hourly_limit === undefined ? 1000 : input.hourly_limit;
  if (!name || Object.keys(input).some(key => !["name", "hourly_limit", "secret"].includes(key)) ||
      typeof hourlyLimit !== "number" || !Number.isInteger(hourlyLimit) || hourlyLimit < 1 || hourlyLimit > 1000000 ||
      (input.secret !== undefined && typeof input.secret !== "boolean")) {
    throw new HttpError(400, "Expected name, optional hourly_limit (1..1000000), and optional secret boolean");
  }
  const publicKey = randomBytes(16).toString("hex");
  const secret = input.secret ? randomBytes(32).toString("hex") : null;
  const secretHash = secret ? await hash(secret) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = ((randomBytes(8).readBigUInt64BE() >> 1n) + 1n).toString();
    const project = await env.DB.prepare(`INSERT INTO projects (id, name, public_key, secret_hash, hourly_limit)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id, name, hourly_limit`)
      .bind(id, name, publicKey, secretHash, hourlyLimit).first();
    if (project) return Response.json({ project, otlp: {
      endpoint: `${new URL(request.url).origin}/v1/logs`,
      headers: { "X-Bicho-Key": publicKey, ...(secret ? { "X-Bicho-Secret": secret } : {}) },
    } }, { status: 201 });
  }
  throw new HttpError(503, "Could not allocate project credentials");
}

export async function listProjects(url: URL, env: Env): Promise<Response> {
  const limit = integer(url, "limit", 50, 100);
  const offset = integer(url, "offset", 0, 1000000);
  const rows = await env.DB.prepare("SELECT id, name, hourly_limit FROM projects ORDER BY id LIMIT ? OFFSET ?").bind(limit + 1, offset).all();
  return Response.json({ projects: rows.results.slice(0, limit), next_offset: rows.results.length > limit ? offset + limit : null });
}

export async function getEvent(env: Env, project: Project, id: string, url?: URL): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, "Invalid event ID");
  const event = await env.DB.prepare("SELECT * FROM events WHERE project_id = ? AND id = ?").bind(project.id, id).first<{ payload_key: string; issue_id: string; timestamp: string; received_at: string; enrichment_status: string; enrichment_key: string | null; enrichment_error: string | null }>();
  if (!event) throw new HttpError(404, "Event not found");
  const payload = await readJson(env, event.payload_key);
  if (!url || !["fields", "max_bytes", "include_enrichment"].some(key => url.searchParams.has(key))) return Response.json(payload);
  const requestedFields = url.searchParams.get("fields");
  const fieldNames = Object.keys(payload);
  const selectableFields = fieldNames.filter(field => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) && !["constructor", "prototype"].includes(field));
  const fields = requestedFields !== null ? requestedFields.split(",") : selectableFields.slice(0, 32);
  if (!fields.length || fields.length > 32 || fields.some(field => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) || ["constructor", "prototype"].includes(field))) throw new HttpError(400, "Invalid event fields");
  const maxBytes = integer(url, "max_bytes", 32768, 65536);
  if (maxBytes < 2048) throw new HttpError(400, "Output budget must be at least 2048 bytes");
  const include = url.searchParams.get("include_enrichment");
  if (include !== null && !["0", "1"].includes(include)) throw new HttpError(400, "Invalid enrichment selection");
  const metadata = {
    provenance: { project_id: project.id, event_id: id, issue_id: event.issue_id, occurred_at: event.timestamp, received_at: event.received_at, untrusted: true, credential_filter_version: 1 },
    available_fields: selectableFields.slice(0, 16),
    available_fields_incomplete: selectableFields.length > 16 || selectableFields.length < fieldNames.length,
  };
  const enrichment = { status: event.enrichment_status, error: event.enrichment_error,
    ...(include === "1" && event.enrichment_key ? { data: await readJson(env, event.enrichment_key) } : {}) };
  const evidence = boundedEvidence({ event: Object.fromEntries(fields.filter(field => Object.hasOwn(payload, field)).map(field => [field, payload[field]])), enrichment }, maxBytes - encoder.encode(JSON.stringify(metadata)).length - 64);
  return Response.json({ ...object(evidence.data), ...metadata, truncated: evidence.truncated || (requestedFields === null && fields.length < fieldNames.length) });
}

export async function getIssue(url: URL, env: Env, project: Project, id: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400, "Invalid issue ID");
  const issue = await env.DB.prepare("SELECT * FROM issues WHERE project_id = ? AND id = ?").bind(project.id, id).first();
  if (!issue) throw new HttpError(404, "Issue not found");
  const query = new URL(url);
  if (query.searchParams.has("issue_id") && query.searchParams.get("issue_id") !== id) throw new HttpError(400, "Conflicting issue ID");
  query.searchParams.set("issue_id", id);
  return Response.json({ issue, ...object(await (await searchEvents(query, env, project)).json()) });
}

const statuses = ["unresolved", "resolved", "ignored", "muted"];

export async function patchIssue(request: Request, env: Env, project: Project, id: string): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(400, "Invalid issue ID");
  const bytes = await body(request, 1024);
  let input: JsonObject;
  try {
    input = object(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (Object.keys(input).length !== 1 || typeof input.status !== "string" || !statuses.includes(input.status)) {
    throw new HttpError(400, "Expected only a valid status");
  }
  const issue = await env.DB.prepare("UPDATE issues SET status = ? WHERE project_id = ? AND id = ? RETURNING *")
    .bind(input.status, project.id, id).first();
  if (!issue) throw new HttpError(404, "Issue not found");
  return Response.json({ issue });
}

export async function listReleases(url: URL, env: Env, project: Project): Promise<Response> {
  const limit = integer(url, "limit", 50, 100);
  const offset = integer(url, "offset", 0, 1000000);
  const releases = await env.DB.prepare(`SELECT release, count(*) AS event_count, min(timestamp) AS first_seen, max(timestamp) AS last_seen
    FROM events WHERE project_id = ? AND release IS NOT NULL AND release <> ''
    GROUP BY release ORDER BY last_seen DESC, release LIMIT ? OFFSET ?`)
    .bind(project.id, limit + 1, offset).all();
  return Response.json({ releases: releases.results.slice(0, limit), next_offset: releases.results.length > limit ? offset + limit : null });
}
