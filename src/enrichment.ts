import { TraceMap, decodedMappings, originalPositionFor, sourceContentFor, type EncodedSourceMap } from "@jridgewell/trace-mapping";
import { HttpError, object, type JsonObject } from "./http.ts";
import type { Env, Project } from "./core.ts";
import { readBody, readJson, putJson, redact, boundedEvidence } from "./payload.ts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const encoder = new TextEncoder();
type Registration = { debug_id: string; payload_key: string; checksum: string; created_at: string };

function debugId(value: string): void {
  if (!uuid.test(value)) throw new HttpError(400, "Invalid debug ID");
}

async function checksum(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateMap(value: unknown): { data: EncodedSourceMap; trace: TraceMap } {
  const raw = object(value);
  const invalid = () => { throw new HttpError(400, "Invalid or unsupported source map"); };
  const string = (value: unknown): value is string => typeof value === "string" && value.length <= 4096;

  if (raw.version !== 3 || raw.sections !== undefined || raw.url !== undefined || typeof raw.mappings !== "string" || !/^[A-Za-z0-9+/;,]*$/.test(raw.mappings)) invalid();
  if (!Array.isArray(raw.sources) || raw.sources.length > 10000 || !raw.sources.every(string)) invalid();
  if (!Array.isArray(raw.names) || raw.names.length > 10000 || !raw.names.every(string)) invalid();
  if (raw.file !== undefined && !string(raw.file)) invalid();
  if (raw.sourceRoot !== undefined && !string(raw.sourceRoot)) invalid();
  if (raw.sourcesContent !== undefined && (!Array.isArray(raw.sourcesContent) || raw.sourcesContent.length !== (raw.sources as string[]).length || !raw.sourcesContent.every(value => value === null || typeof value === "string"))) invalid();
  const data: EncodedSourceMap = {
    version: 3, sources: raw.sources as string[], names: raw.names as string[], mappings: raw.mappings as string,
    ...(raw.file !== undefined ? { file: raw.file as string } : {}),
    ...(raw.sourceRoot !== undefined ? { sourceRoot: raw.sourceRoot as string } : {}),
    ...(raw.sourcesContent !== undefined ? { sourcesContent: raw.sourcesContent as (string | null)[] } : {}),
  };
  let segments = 1;
  let values = 0;
  let digits = 0;
  let vlq = 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (const char of data.mappings) {
    if (char === "," || char === ";") {
      if (digits || (values && ![1, 4, 5].includes(values)) || (char === "," && !values)) invalid();
      if (++segments > 50000) invalid();
      values = 0;
    } else {
      const code = alphabet.indexOf(char);
      vlq += (code & 31) * 2 ** (5 * digits);
      if (++digits > 7 || vlq > 0xffffffff) invalid();
      if (!(code & 32)) { values++; digits = 0; vlq = 0; }
    }
  }
  if (digits || (values && ![1, 4, 5].includes(values)) || data.mappings.endsWith(",")) invalid();
  const trace = new TraceMap(data);
  for (const line of decodedMappings(trace)) {
    for (const segment of line) {
      if (!segment.every(value => Number.isSafeInteger(value) && value >= 0)) invalid();
      if (segment.length > 1 && (segment[1]! >= data.sources.length || (segment.length === 5 && segment[4]! >= data.names.length))) invalid();
    }
  }
  return { data, trace };
}

async function registration(env: Env, projectId: string, id: string): Promise<Registration | null> {
  return env.DB.prepare("SELECT debug_id,payload_key,checksum,created_at FROM source_maps WHERE project_id=? AND lower(debug_id)=lower(?)").bind(projectId, id).first<Registration>();
}

function metadata(row: Registration, status = 200): Response {
  return Response.json({ debug_id: row.debug_id, checksum: row.checksum, created_at: row.created_at }, { status });
}

export async function getSourceMap(env: Env, project: Project, id: string): Promise<Response> {
  debugId(id);
  const row = await registration(env, project.id, id);
  if (!row) throw new HttpError(404, "Source map not found");
  return metadata(row);
}

export async function uploadSourceMap(request: Request, env: Env, project: Project, id: string): Promise<Response> {
  debugId(id);
  let raw: JsonObject;
  try { raw = object(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readBody(request)))); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid source map JSON");
  }
  for (const key of ["debug_id", "debugId"]) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !uuid.test(raw[key]) || raw[key].toLowerCase() !== id.toLowerCase())) throw new HttpError(400, "Conflicting source map debug ID");
  }
  const { data } = validateMap(raw);
  const sum = await checksum(data);
  const existing = await registration(env, project.id, id);
  if (existing) {
    if (existing.checksum !== sum) throw new HttpError(409, "Source map debug ID is immutable");
    return metadata(existing);
  }
  const key = `source-maps/${encodeURIComponent(project.id)}/${id}/${crypto.randomUUID()}.json.gz`;
  await putJson(env, key, data);
  await env.DB.prepare("INSERT INTO source_maps(project_id,debug_id,payload_key,checksum,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM source_maps WHERE project_id=? AND lower(debug_id)=lower(?))")
    .bind(project.id, id, key, sum, new Date().toISOString(), project.id, id).all();
  const canonical = await registration(env, project.id, id);
  if (!canonical) throw new Error("Source map registration unavailable");
  if (canonical.payload_key !== key) await env.PAYLOADS.delete(key);
  if (canonical.checksum !== sum) throw new HttpError(409, "Source map debug ID is immutable");
  return metadata(canonical, canonical.payload_key === key ? 201 : 200);
}

type Candidate = { project_id: string; id: string; payload_key: string; enrichment_key: string | null; enrichment_cursor: number; enrichment_revision: number };
type FrameResult = { path: string; captured: unknown; captured_truncated: boolean; debug_id?: string; mapped?: JsonObject; reason?: string; context_missing?: boolean; context_truncated?: boolean };

function stackFrames(event: JsonObject): { frames: { path: string; frame: JsonObject }[]; total: number } {
  const frames: { path: string; frame: JsonObject }[] = [];
  let total = 0;
  function stack(value: unknown, path: string) {
    if (value === undefined || value === null) return;
    const list = object(value).frames;
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) throw new HttpError(400, "Invalid captured stack");
    total += list.length;
    for (let index = 0; index < list.length && frames.length < 1000; index++) frames.push({ path: `${path}.frames[${index}]`, frame: object(list[index]) });
  }
  stack(event.stacktrace, "stacktrace");
  for (const field of ["exception", "threads"] as const) {
    const value = event[field];
    if (value === undefined || value === null) continue;
    const entries = Array.isArray(value) ? value : object(value).values;
    if (!Array.isArray(entries)) throw new HttpError(400, "Invalid captured stack chain");
    for (let index = 0; index < entries.length; index++) stack(object(entries[index]).stacktrace, `${field}${Array.isArray(value) ? "" : ".values"}[${index}].stacktrace`);
  }
  return { frames, total };
}

async function enrich(env: Env, candidate: Candidate, budget: { lookups: number }) {
  const cache = new Map<string, TraceMap | null>();
  const event = await readJson(env, candidate.payload_key);
  const images = event.debug_meta == null ? [] : object(event.debug_meta).images ?? [];
  if (!Array.isArray(images)) throw new HttpError(400, "Invalid debug images");
  const { frames, total } = stackFrames(event);
  const previous = candidate.enrichment_cursor && candidate.enrichment_key ? await readJson(env, candidate.enrichment_key) : null;
  const results: FrameResult[] = previous ? previous.frames as FrameResult[] : [];
  let bytes = results.reduce((sum, frame) => sum + encoder.encode(JSON.stringify(frame)).length, 0);
  let mapped = results.filter(frame => frame.mapped).length;
  let missing = results.some(frame => frame.reason === "missing_source_map");
  let invalid = results.some(frame => frame.reason && !["missing_source_map", "no_source_map_reference"].includes(frame.reason));
  let supported = previous?.supported === true;
  let paused = false;
  let truncated = total > frames.length;
  let truncationReason = truncated ? "frame_limit" : null;
  let contextSource: string | null = null;
  let contextLines: string[] = [];
  for (const { path, frame } of frames.slice(candidate.enrichment_cursor)) {
    const captured = boundedEvidence(redact(frame), 1024);
    const result: FrameResult = { path, captured: captured.data, captured_truncated: captured.truncated };
    const references = images.filter(value => {
      const image = object(value);
      return image.type === "sourcemap" && typeof image.code_file === "string" && (image.code_file === frame.filename || image.code_file === frame.abs_path);
    }).map(value => object(value).debug_id);
    const ids = [...new Set(references.map(value => typeof value === "string" ? value.toLowerCase() : value))];
    let id: unknown = frame.debug_id;
    if (id === undefined && ids.length === 1) id = references[0];
    if (id === undefined && ids.length > 1) { result.reason = "ambiguous_debug_id"; invalid = true; supported = true; }
    else if (id === undefined) result.reason = "no_source_map_reference";
    else if (typeof id !== "string" || !uuid.test(id)) { result.reason = "invalid_debug_id"; invalid = true; supported = true; }
    else {
      result.debug_id = id;
      supported = true;
      if (typeof frame.lineno !== "number" || !Number.isSafeInteger(frame.lineno) || frame.lineno < 1 || typeof frame.colno !== "number" || !Number.isSafeInteger(frame.colno) || frame.colno < 1) {
        result.reason = frame.colno === undefined ? "missing_column" : "invalid_position";
        invalid = true;
      } else {
        const cacheKey = JSON.stringify([candidate.project_id, id.toLowerCase()]);
        if (!cache.has(cacheKey)) {
          if (budget.lookups === 0) { truncated = true; truncationReason = "lookup_budget"; paused = true; break; }
          budget.lookups--;
          if (cache.size >= 5) cache.delete(cache.keys().next().value!);
          const row = await registration(env, candidate.project_id, id);
          let trace: TraceMap | null = null;
          if (row) {
            const raw = await readJson(env, row.payload_key);
            const validated = validateMap(raw);
            if (await checksum(validated.data) !== row.checksum) throw new Error("Source map checksum mismatch");
            trace = validated.trace;
          }
          cache.set(cacheKey, trace);
        }
        const trace = cache.get(cacheKey)!;
        if (!trace) { result.reason = "missing_source_map"; missing = true; }
        else {
          const original = originalPositionFor(trace, { line: frame.lineno, column: frame.colno - 1 });
          if (original.source === null || original.line === null || original.column === null) { result.reason = "unmapped_position"; invalid = true; }
          else {
            result.mapped = { filename: original.source, function: original.name, lineno: original.line, colno: original.column + 1, pre_context: [], context_line: null, post_context: [] };
            const source = sourceContentFor(trace, original.source);
            if (source === null) result.context_missing = true;
            else {
              if (source !== contextSource) { contextSource = source; contextLines = source.split(/\r\n|\n|\r/); }
              const lines = contextLines;
              const index = original.line - 1;
              if (index >= lines.length) result.context_missing = true;
              else {
                const clip = (line: string) => {
                  const safe = redact(line) as string;
                  if (safe.length > 256) result.context_truncated = true;
                  return safe.slice(0, 256);
                };
                result.mapped.pre_context = lines.slice(Math.max(0, index - 2), index).map(clip);
                result.mapped.context_line = clip(lines[index]!);
                result.mapped.post_context = lines.slice(index + 1, index + 3).map(clip);
              }
            }
            mapped++;
          }
        }
      }
    }
    const safe = object(redact(result)) as FrameResult;
    const size = encoder.encode(JSON.stringify(safe)).length;
    if (bytes + size > 1800000) { truncated = true; truncationReason = "output_byte_limit"; break; }
    bytes += size;
    results.push(safe);
  }
  const status = paused ? "pending" : truncated ? "failed" : missing ? "pending" : invalid ? "failed" : mapped ? "succeeded" : "not_applicable";
  return { version: 1, status, frames: results, total_frames: total, processed_frames: results.length, mapped_frames: results.filter(frame => frame.mapped).length, truncated, truncation_reason: truncationReason, incomplete: truncated || results.some(frame => frame.reason || frame.context_missing || frame.context_truncated || frame.captured_truncated), supported };
}

export async function processEnrichment(env: Env): Promise<void> {
  let processed = 0;
  let failed = 0;
  const started = new Date().toISOString();
  const runId = crypto.randomUUID();
  const cooldown = new Date(Date.now() - 60000).toISOString();
  const expired = new Date(Date.now() - 5 * 60000).toISOString();
  const retryBefore = new Date(Date.now() - 60 * 60000).toISOString();
  const budget = { lookups: 100 };
  const eligible = "(enrichment_status='pending' AND enrichment_checked_at IS NULL) OR (enrichment_status='failed' AND enrichment_error='Source map enrichment failed' AND enrichment_attempts < 3 AND enrichment_checked_at <= ?)";
  const claim = await env.DB.prepare(`INSERT INTO processing_state(name,run_id,last_started_at,last_finished_at,processed,failed,error)
    SELECT 'source_maps',?,?,NULL,0,0,NULL WHERE EXISTS (SELECT 1 FROM events WHERE ${eligible})
    ON CONFLICT(name) DO UPDATE SET run_id=excluded.run_id,last_started_at=excluded.last_started_at,last_finished_at=NULL,processed=0,failed=0,error=NULL
    WHERE (processing_state.run_id IS NULL AND processing_state.last_started_at <= ?) OR processing_state.last_started_at <= ?
    RETURNING run_id`).bind(runId, started, retryBefore, cooldown, expired).first<{ run_id: string }>();
  if (!claim) return;
  try {
    const { results: candidates } = await env.DB.prepare(`SELECT project_id,id,payload_key,enrichment_key,enrichment_cursor,enrichment_revision FROM events WHERE ${eligible} ORDER BY coalesce(enrichment_checked_at,received_at),received_at,project_id,id LIMIT 25`).bind(retryBefore).all<Candidate>();
    for (const candidate of candidates) {
      if ((await env.DB.prepare("SELECT run_id FROM processing_state WHERE name='source_maps'").first<{ run_id: string }>())?.run_id !== runId) return;
      const checked = new Date().toISOString();
      try {
        const result = await enrich(env, candidate, budget);
        const cursor = result.truncation_reason === "lookup_budget" ? result.processed_frames : 0;
        const key = `enrichment/${encodeURIComponent(candidate.project_id)}/${encodeURIComponent(candidate.id)}/v1/${await checksum(result)}.json.gz`;
        await putJson(env, key, result);
        await env.DB.prepare("UPDATE events SET enrichment_status=?,enrichment_key=?,enrichment_error=?,enrichment_checked_at=?,enrichment_cursor=?,enrichment_attempts=0 WHERE project_id=? AND id=? AND enrichment_revision=? AND enrichment_status IN ('pending','failed') AND EXISTS (SELECT 1 FROM processing_state WHERE name='source_maps' AND run_id=?)")
          .bind(result.status, key, result.status === "failed" ? "Source map enrichment incomplete" : null, cursor ? null : checked, cursor, candidate.project_id, candidate.id, candidate.enrichment_revision, runId).all();
        if (result.status === "failed") failed++;
        processed++;
      } catch (error) {
        failed++;
        processed++;
        await env.DB.prepare("UPDATE events SET enrichment_status='failed',enrichment_error=?,enrichment_checked_at=?,enrichment_attempts=enrichment_attempts+1 WHERE project_id=? AND id=? AND enrichment_revision=? AND enrichment_status IN ('pending','failed') AND EXISTS (SELECT 1 FROM processing_state WHERE name='source_maps' AND run_id=?)")
          .bind(error instanceof HttpError && error.status < 500 ? "Invalid source map evidence" : "Source map enrichment failed", checked, candidate.project_id, candidate.id, candidate.enrichment_revision, runId).all();
      }
      if (budget.lookups === 0) break;
    }
    await env.DB.prepare("UPDATE processing_state SET run_id=NULL,last_finished_at=?,processed=?,failed=?,error=? WHERE name='source_maps' AND run_id=?")
      .bind(new Date().toISOString(), processed, failed, failed ? "Some events could not be enriched" : null, runId).all();
  } catch {
    await env.DB.prepare("UPDATE processing_state SET run_id=NULL,last_finished_at=?,processed=?,failed=?,error=? WHERE name='source_maps' AND run_id=?")
      .bind(new Date().toISOString(), processed, failed, "Source map processing failed", runId).all();
    throw new Error("Source map processing failed");
  }
}
