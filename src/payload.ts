import { HttpError, object, type JsonObject } from "./http.ts";
import type { Env } from "./core.ts";

const encoder = new TextEncoder();
const sensitive = /^(?:http\.(?:request|response)\.header\.)?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|client[-_]?secret|.*[-_]?token|(?:x[-_])?api[-_]?key|access[-_]?key|private[-_]?key)$/i;

export function redact(value: unknown, depth = 0, pairs = false): unknown {
  if (depth > 64) throw new HttpError(400, "Event nesting exceeds limit");
  if (typeof value === "string") {
    return value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "$1 [Filtered]")
      .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[Filtered]@")
      .replace(/(^|[?&])([^=&?#\s]+)=([^&#\s]*)/g, (match, separator: string, key: string) => {
        try { return sensitive.test(decodeURIComponent(key.replaceAll("+", " "))) ? `${separator}${key}=[Filtered]` : match; }
        catch { return match; }
      });
  }
  if (Array.isArray(value)) {
    if (pairs && value.length === 2 && typeof value[0] === "string" && sensitive.test(value[0])) return [value[0], "[Filtered]"];
    return value.map(item => redact(item, depth + 1, pairs));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? "[Filtered]" : redact(item, depth + 1, /^(headers|tags)$/i.test(key))]));
  }
  return value;
}

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "Request body exceeds size limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBody(request: Request, limit = 2 * 1024 * 1024): Promise<Uint8Array> {
  const encoding = request.headers.get("Content-Encoding")?.toLowerCase();
  if (encoding && !["identity", "gzip", "deflate"].includes(encoding)) throw new HttpError(415, "Unsupported content encoding");
  let wireSize = 0;
  let stream = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      wireSize += chunk.byteLength;
      if (wireSize > limit) throw new HttpError(413, "Request body exceeds size limit");
      controller.enqueue(chunk);
    },
  })) ?? null;
  if (!stream) throw new HttpError(400, "Empty request body");
  if (encoding === "gzip" || encoding === "deflate") stream = stream.pipeThrough(new DecompressionStream(encoding));
  try { return await collect(stream, limit); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request body");
  }
}

export async function putJson(env: Env, key: string, value: unknown): Promise<void> {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > 2 * 1024 * 1024) throw new HttpError(413, "Stored JSON exceeds size limit");
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  await env.PAYLOADS.put(key, await collect(compressed, 3 * 1024 * 1024), { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } });
}

export async function readJson(env: Env, key: string): Promise<JsonObject> {
  const payload = await env.PAYLOADS.get(key);
  if (!payload) throw new HttpError(503, "Event payload unavailable");
  let stream = new Response(payload.body).body!;
  if (payload.httpMetadata?.contentEncoding === "gzip") stream = stream.pipeThrough(new DecompressionStream("gzip"));
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await collect(stream, 2 * 1024 * 1024))));
}

export function boundedEvidence(value: unknown, maxBytes: number): { data: unknown; truncated: boolean } {
  let truncated = false;
  function clip(input: unknown, depth: number, width: number, length: number): unknown {
    if (typeof input === "string" && input.length > length) { truncated = true; return input.slice(0, length) + "…"; }
    if (!input || typeof input !== "object") return input;
    if (depth >= 8) { truncated = true; return "[Truncated]"; }
    if (Array.isArray(input)) {
      if (input.length > width) truncated = true;
      return input.slice(0, width).map(item => clip(item, depth + 1, width, length));
    }
    const entries = Object.entries(input);
    if (entries.length > width) truncated = true;
    return Object.fromEntries(entries.slice(0, width).map(([key, item]) => [key, clip(item, depth + 1, width, length)]));
  }
  let data = value;
  for (const [width, length] of [[20, 2048], [10, 512], [5, 128], [2, 32]] as const) {
    if (encoder.encode(JSON.stringify(data)).length <= maxBytes) return { data, truncated };
    data = clip(value, 0, width, length);
  }
  if (encoder.encode(JSON.stringify(data)).length <= maxBytes) return { data, truncated };
  return { data: { error: "Evidence exceeds output budget; request fewer fields" }, truncated: true };
}
