import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { LogsRequest, LogsResponse, RpcStatus } from "./vendor/otlp/schema.ts";
import { hash, matches, prepareEvent, persistEvent, type Env, type Project } from "./core.ts";
import { HttpError, object, type JsonObject } from "./http.ts";
import { readBody, redact } from "./payload.ts";

const protobuf = (request: Request) => request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() === "application/x-protobuf";
function response(request: Request, value: JsonObject, status = 200, headers: Record<string, string> = {}): Response {
  const schema = status === 200 ? LogsResponse : RpcStatus;
  if (protobuf(request)) return new Response(toBinary(schema, fromJson(schema, value as JsonValue)), { status, headers: { ...headers, "Content-Type": "application/x-protobuf" } });
  return Response.json(value, { status, headers });
}
export function otlpError(request: Request, error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 503;
  const code = ({ 400: 3, 403: 7, 405: 12, 413: 8, 415: 3, 429: 8, 503: 14 } as Record<number, number>)[status] ?? 13;
  const headers = error instanceof HttpError ? { ...error.headers } : {};
  return response(request, { code, message: error instanceof HttpError ? error.message : "Ingestion temporarily unavailable" }, status, headers);
}

function validate(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (depth > 32 || ++budget.count > 20000) throw new HttpError(400, "OTLP structure exceeds limit");
  if (Array.isArray(value)) { for (const item of value) validate(item, depth + 1, budget); }
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["resource_logs", "scope_logs", "log_records", "severity_number", "time_unix_nano", "observed_time_unix_nano", "trace_id", "span_id", "string_value", "int_value", "bool_value", "double_value", "array_value", "kvlist_value", "bytes_value"].includes(key)) throw new HttpError(400, "OTLP JSON requires lowerCamelCase fields");
      if (key === "severityNumber" && (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 24)) throw new HttpError(400, "Invalid severity number");
      if (["timeUnixNano", "observedTimeUnixNano"].includes(key) && !(typeof item === "string" && /^\d{1,20}$/.test(item) && BigInt(item) <= 18446744073709551615n || typeof item === "number" && Number.isSafeInteger(item) && item >= 0)) throw new HttpError(400, "Invalid nanosecond timestamp");
      validate(item, depth + 1, budget);
    }
  }
}
function correlation(value: JsonObject, binary = false): void {
  for (const key of ["traceId", "spanId"]) {
    const size = key === "traceId" ? 32 : 16;
    const id = value[key];
    if (id === undefined) continue;
    let hex = "";
    if (binary && typeof id === "string") {
      hex = Array.from(atob(id), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } else if (typeof id === "string") hex = id;
    if (!new RegExp(`^[0-9a-f]{${size}}$`, "i").test(hex) || /^0+$/.test(hex)) { delete value[key]; continue; }
    value[key] = binary ? hex.toLowerCase() : btoa(String.fromCharCode(...hex.match(/../g)!.map(byte => parseInt(byte, 16))));
  }
}
function records(input: JsonObject): { resource: JsonObject; scope: JsonObject; logRecord: JsonObject; resourceSchemaUrl: unknown; scopeSchemaUrl: unknown }[] {
  const result = [];
  for (const resourceLog of (input.resourceLogs ?? []) as JsonObject[]) {
    for (const scopeLog of (resourceLog.scopeLogs ?? []) as JsonObject[]) {
      for (const logRecord of (scopeLog.logRecords ?? []) as JsonObject[]) {
        result.push({ resource: object(resourceLog.resource ?? {}), scope: object(scopeLog.scope ?? {}), logRecord, resourceSchemaUrl: resourceLog.schemaUrl, scopeSchemaUrl: scopeLog.schemaUrl });
        if (result.length > 100) throw new HttpError(413, "OTLP batch exceeds 100 records");
      }
    }
  }
  return result;
}
function anyValue(value: JsonObject): unknown {
  if (value.arrayValue) return ((object(value.arrayValue).values ?? []) as JsonObject[]).map(anyValue);
  if (value.kvlistValue) return attributes(object(value.kvlistValue).values);
  return Object.values(value)[0];
}
function attributes(value: unknown): JsonObject {
  return Object.fromEntries(((value ?? []) as JsonObject[]).map(pair => [String(pair.key ?? ""), anyValue(object(pair.value ?? {}))]));
}
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return redact(value);
  const obj = value as JsonObject;
  if (typeof obj.key === "string" && obj.value && Object.hasOwn(obj, "value")) {
    const filtered = object(redact({ [obj.key]: "sentinel" }))[obj.key] !== "sentinel";
    return { ...obj, value: filtered ? { stringValue: "[Filtered]" } : sanitize(obj.value) };
  }
  return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, sanitize(item)]));
}
function frames(stack: string): JsonObject[] {
  const result: JsonObject[] = [];
  for (const line of stack.split("\n").slice(0, 200)) {
    const js = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    const py = /^\s*File "(.+)", line (\d+), in (.+)$/.exec(line);
    const ruby = /^\s*(.+?):(\d+):in [`'](.+)'$/.exec(line);
    const php = /^#\d+\s+(.+)\((\d+)\):\s*(.+)$/.exec(line);
    const rust = /^\s*at (.+?):(\d+):(\d+)$/.exec(line);
    if (js) result.push({ filename: js[2], function: js[1] ?? "", lineno: Number(js[3]), colno: Number(js[4]) });
    else if (py || ruby || php) { const m = (py ?? ruby ?? php)!; result.push({ filename: m[1], lineno: Number(m[2]), function: m[3] }); }
    else if (rust) result.push({ filename: rust[1], lineno: Number(rust[2]), colno: Number(rust[3]) });
    if (result.length === 100) break;
  }
  return stack.includes("Traceback (most recent call last):") ? result.reverse() : result;
}
async function normalize(capture: ReturnType<typeof records>[number], project: Project) {
  const captured = object(sanitize(capture));
  const log = object(captured.logRecord);
  const attrs = attributes(log.attributes);
  const res = attributes(object(captured.resource).attributes);
  const severity = Number(log.severityNumber ?? 0);
  const exception = ["exception.type", "exception.message", "exception.stacktrace"].some(key => typeof attrs[key] === "string" && attrs[key] !== "");
  if (!exception && severity < 17) return null;
  const uid = attributes(capture.logRecord.attributes)["log.record.uid"];
  if (uid !== undefined && (typeof uid !== "string" || !uid.length || uid.length > 512)) throw new HttpError(400, "Invalid log.record.uid");
  const id = uid === undefined ? crypto.randomUUID().replaceAll("-", "") : (await hash(JSON.stringify(["otlp", project.id, uid]))).slice(0, 32);
  const derived = frames(typeof attrs["exception.stacktrace"] === "string" ? attrs["exception.stacktrace"] : "");
  const tags = Object.fromEntries(Object.entries({ ...res, ...attrs }).filter(([key, value]) => key.length <= 128 && ["string", "number", "boolean"].includes(typeof value) && String(value).length <= 512).slice(0, 32));
  const nanos = BigInt(String(log.timeUnixNano ?? "0")) || BigInt(String(log.observedTimeUnixNano ?? "0"));
  const body = log.body ? anyValue(object(log.body)) : "Unknown error";
  const message = typeof attrs["exception.message"] === "string" ? attrs["exception.message"] : typeof body === "string" ? body : JSON.stringify(body) ?? "Unknown error";
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 512) : undefined;
  const event: JsonObject = {
    event_id: id, payload_format: "otlp.logs.v1", otlp: captured, derived: { frames: derived }, message: message.slice(0, 16384),
    exception: { values: [{ type: text(attrs["exception.type"]) ?? "Error", value: message.slice(0, 16384), stacktrace: { frames: derived.slice().reverse() } }] },
    level: severity >= 21 ? "fatal" : severity >= 17 || !severity ? "error" : severity >= 13 ? "warning" : severity >= 9 ? "info" : "debug",
    environment: text(res["deployment.environment.name"] ?? res["deployment.environment"]), release: text(res["service.version"]), tags,
    ...(nanos ? { timestamp: new Date(Number(nanos / 1000000n)).toISOString() } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(event)).length > 1024 * 1024) throw new HttpError(413, "OTLP record exceeds size limit");
  return prepareEvent(event, {});
}
export async function ingestLogs(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get("X-Bicho-Key");
  const secret = request.headers.get("X-Bicho-Secret") ?? "";
  if (!key || key.length > 512 || secret.length > 512) throw new HttpError(403, "Invalid ingest credentials");
  const project = await env.DB.prepare("SELECT id, public_key, secret_hash, hourly_limit FROM projects WHERE public_key = ?").bind(key).first<Project>();
  if (!project || (project.secret_hash && !await matches(secret, project.secret_hash))) throw new HttpError(403, "Invalid ingest credentials");
  const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !protobuf(request)) throw new HttpError(415, "Unsupported OTLP content type");
  const bytes = await readBody(request);
  let input: JsonObject;
  try {
    if (protobuf(request)) input = object(toJson(LogsRequest, fromBinary(LogsRequest, bytes, { recursionLimit: 32 }), { enumAsInteger: true }));
    else {
      const raw = object(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
      validate(raw);
      for (const entry of records(raw)) correlation(entry.logRecord);
      input = object(toJson(LogsRequest, fromJson(LogsRequest, raw as JsonValue, { ignoreUnknownFields: true }), { enumAsInteger: true }));
    }
    validate(input);
    for (const entry of records(input)) correlation(entry.logRecord, true);
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid OTLP logs payload"); }
  const events = await Promise.all(records(input).map(capture => normalize(capture, project)));
  let rejected = events.filter(event => !event).length;
  let accepted = 0;
  let errorMessage = rejected ? "Ordinary logs below ERROR are outside the error-tracker scope" : "";
  const supported = events.filter(event => event !== null);
  for (const event of supported) {
    try { await persistEvent(env, project, event); accepted++; }
    catch (error) {
      if (!accepted) throw error instanceof HttpError ? error : new HttpError(503, "Ingestion temporarily unavailable");
      rejected += supported.length - accepted;
      errorMessage = "Some records could not be stored; do not retry the accepted batch";
      break;
    }
  }
  return response(request, rejected ? { partialSuccess: { rejectedLogRecords: String(rejected), errorMessage } } : {});
}
