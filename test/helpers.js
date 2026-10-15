import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { prepareEvent, persistEvent } from "../src/core.ts";
import { HttpError } from "../src/http.ts";

export async function capture(env, event, projectId = "1") {
  try {
    const project = await env.DB.prepare("SELECT id, public_key, secret_hash, hourly_limit FROM projects WHERE id = ?").bind(projectId).first();
    const prepared = await prepareEvent(event, {});
    await persistEvent(env, project, prepared);
    return Response.json({ id: prepared.id });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return Response.json({ error: error.message }, { status: error.status, headers: error.headers });
  }
}

export const logs = records => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });
export const log = uid => ({ severityNumber: 17, body: { stringValue: "runtime bug" }, attributes: [{ key: "log.record.uid", value: { stringValue: uid } }] });

export function bindings() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"));
  sqlite.prepare("INSERT INTO projects (id, name, public_key) VALUES (?, ?, ?)").run("1", "test", "public");
  sqlite.prepare("INSERT INTO projects (id, name, public_key) VALUES (?, ?, ?)").run("2", "other", "other");
  const blobs = new Map();
  const metadata = new Map();
  function prepare(sql) {
    let values = [];
    const execute = () => sqlite.prepare(sql).all(...values);
    return {
      bind(...args) { values = args; return this; },
      async first() { return execute()[0] ?? null; },
      async all() { return { results: execute(), success: true }; },
      execute,
    };
  }
  return {
    sqlite,
    blobs,
    env: {
      BICHO_ADMIN_TOKEN: "admin-test-token",
      DB: {
        prepare,
        async batch(statements) {
          sqlite.exec("BEGIN");
          try {
            const results = statements.map(stmt => ({ results: stmt.execute(), success: true }));
            sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      },
      PAYLOADS: {
        async put(key, value, options) { blobs.set(key, value); metadata.set(key, options?.httpMetadata); },
        async get(key) { return blobs.has(key) ? { body: blobs.get(key), httpMetadata: metadata.get(key) } : null; },
        async delete(key) { blobs.delete(key); },
      },
    },
  };
}
