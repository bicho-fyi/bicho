import { matches, prepareEvent, persistEvent, type Env, type Project } from "./core.ts";
import { HttpError, object, type JsonObject } from "./http.ts";
import { readBody } from "./payload.ts";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
function validate(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (depth > 32 || ++budget.count > 20000) throw new HttpError(400, "Sentry structure exceeds limit");
  if (Array.isArray(value)) for (const item of value) validate(item, depth + 1, budget);
  else if (value && typeof value === "object") for (const item of Object.values(value)) validate(item, depth + 1, budget);
}
function json(bytes: Uint8Array): JsonObject {
  try {
    const value = object(JSON.parse(decoder.decode(bytes)));
    validate(value);
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid Sentry JSON");
  }
}
function envelope(bytes: Uint8Array) {
  let offset = 0;
  const line = () => {
    const end = bytes.indexOf(10, offset);
    const value = bytes.subarray(offset, end < 0 ? bytes.length : end);
    offset = end < 0 ? bytes.length : end + 1;
    return value;
  };
  const headers = json(line());
  const items: { type: string; bytes: Uint8Array }[] = [];
  while (offset < bytes.length) {
    const header = json(line());
    if (offset === bytes.length && bytes[bytes.length - 1] !== 10) throw new HttpError(400, "Missing Sentry item payload");
    if (typeof header.type !== "string" || !header.type.length || header.type.length > 128) throw new HttpError(400, "Invalid Sentry item type");
    let payload;
    if (header.length === undefined) payload = line();
    else {
      if (!Number.isSafeInteger(header.length) || (header.length as number) < 0 || (header.length as number) > bytes.length - offset) throw new HttpError(400, "Invalid Sentry item length");
      const end = offset + (header.length as number);
      payload = bytes.subarray(offset, end);
      if (end < bytes.length && bytes[end] !== 10) throw new HttpError(400, "Invalid Sentry item delimiter");
      offset = end < bytes.length ? end + 1 : end;
    }
    items.push({ type: header.type, bytes: payload });
    if (items.length > 100) throw new HttpError(413, "Sentry envelope exceeds 100 items");
  }
  return { headers, items };
}
async function authenticate(request: Request, env: Env, id: string, headers: JsonObject): Promise<Project> {
  if (!/^[1-9]\d{0,18}$/.test(id)) throw new HttpError(400, "Invalid project ID");
  const url = new URL(request.url);
  const keys: string[] = [];
  const secrets: string[] = [];
  const add = (key: unknown, secret: unknown) => {
    if (typeof key !== "string" || !key.length || key.length > 512 || (secret !== undefined && (typeof secret !== "string" || secret.length > 512))) throw new HttpError(403, "Invalid ingest credentials");
    keys.push(key);
    if (secret !== undefined) secrets.push(secret as string);
  };
  const query = url.searchParams;
  if ([...query.keys()].some(key => key.startsWith("sentry_"))) {
    for (const key of ["sentry_key", "sentry_secret", "sentry_version"]) if (query.getAll(key).length > 1) throw new HttpError(403, "Conflicting ingest credentials");
    if (query.get("sentry_version") !== "7") throw new HttpError(403, "Invalid Sentry protocol version");
    add(query.get("sentry_key"), query.get("sentry_secret") ?? undefined);
  }
  const auth = request.headers.get("X-Sentry-Auth");
  if (auth !== null) {
    if (!/^Sentry\s+/i.test(auth) || auth.length > 4096) throw new HttpError(403, "Invalid Sentry authentication");
    const fields = new Map<string, string>();
    for (const part of auth.replace(/^Sentry\s+/i, "").split(",")) {
      const match = /^\s*(sentry_\w+)\s*=\s*([^,]*?)\s*$/.exec(part);
      if (!match || fields.has(match[1]!)) throw new HttpError(403, "Invalid Sentry authentication");
      fields.set(match[1]!, match[2]!);
    }
    if (fields.get("sentry_version") !== "7") throw new HttpError(403, "Invalid Sentry protocol version");
    add(fields.get("sentry_key"), fields.get("sentry_secret"));
  }
  if (headers.dsn !== undefined) {
    try {
      if (typeof headers.dsn !== "string" || headers.dsn.length > 2048) throw new Error();
      const dsn = new URL(headers.dsn);
      if (dsn.origin !== url.origin || dsn.pathname !== `/${id}` || dsn.search || dsn.hash) throw new Error();
      add(decodeURIComponent(dsn.username), dsn.password ? decodeURIComponent(dsn.password) : undefined);
    } catch { throw new HttpError(403, "Invalid envelope DSN"); }
  }
  const secret = request.headers.get("X-Bicho-Secret");
  if (secret !== null) secrets.push(secret);
  if (!keys.length || keys.some(key => key !== keys[0]) || secrets.some(value => value !== secrets[0]) || secrets.some(value => value.length > 512)) throw new HttpError(403, "Conflicting or missing ingest credentials");
  const project = await env.DB.prepare("SELECT id, public_key, secret_hash, hourly_limit FROM projects WHERE public_key = ?").bind(keys[0]).first<Project>();
  if (!project || project.id !== id || (project.secret_hash && !await matches(secrets[0] ?? "", project.secret_hash))) throw new HttpError(403, "Invalid ingest credentials");
  return project;
}
export function sentryError(error: unknown): Response {
  const failure = error instanceof HttpError ? error : new HttpError(503, "Ingestion temporarily unavailable");
  const headers = new Headers(failure.headers);
  if (failure.status === 429) headers.set("X-Sentry-Rate-Limits", `${headers.get("Retry-After") ?? "60"}:error:project:quota_exceeded`);
  return Response.json({ error: failure.message }, { status: failure.status, headers });
}
export async function ingestSentry(request: Request, env: Env, id: string, store = false): Promise<Response> {
  const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  const types = store ? ["application/json", "text/plain"] : ["application/x-sentry-envelope", "text/plain", "application/json", "multipart/form-data", "application/x-www-form-urlencoded"];
  if (contentType && !types.includes(contentType)) throw new HttpError(415, "Unsupported Sentry content type");
  const bytes = await readBody(request);
  const parsed = store ? { headers: {}, items: [{ type: "event", bytes }] } : envelope(bytes);
  const project = await authenticate(request, env, id, parsed.headers);
  const events: Awaited<ReturnType<typeof prepareEvent>>[] = [];
  const discarded: Record<string, number> = Object.create(null);
  for (const item of parsed.items) {
    if (item.type !== "event") { discarded[item.type] = (discarded[item.type] ?? 0) + 1; continue; }
    if (item.bytes.length > 1024 * 1024) throw new HttpError(413, "Sentry event exceeds size limit");
    const event = json(item.bytes);
    if (event.type !== undefined && !["default", "error"].includes(String(event.type))) { discarded.unsupported_event = (discarded.unsupported_event ?? 0) + 1; continue; }
    const prepared = await prepareEvent({ ...event, payload_format: "sentry.event" }, parsed.headers);
    if (encoder.encode(JSON.stringify(prepared.payload)).length > 1024 * 1024) throw new HttpError(413, "Sentry event exceeds size limit");
    events.push(prepared);
  }
  const accepted: string[] = [];
  let failure: Response | undefined;
  for (const event of events) {
    try { await persistEvent(env, project, event); accepted.push(event.id); }
    catch (error) { if (!accepted.length) throw error; failure = sentryError(error); break; }
  }
  const rejected = events.slice(accepted.length).map(event => event.id);
  return Response.json({ ...(accepted[0] ? { id: accepted[0] } : {}), accepted, rejected, discarded,
    ...(failure ? { error: "Some events could not be stored; do not retry the accepted envelope" } : {}),
  }, { headers: failure?.headers.has("X-Sentry-Rate-Limits") ? { "X-Sentry-Rate-Limits": failure.headers.get("X-Sentry-Rate-Limits")! } : {} });
}
