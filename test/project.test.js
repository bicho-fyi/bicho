import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

test("project provisioning writes valid SQL and private credentials without overwriting", () => {
  mkdirSync("_temp", { recursive: true });
  const cwd = mkdtempSync(resolve("_temp/project-test-"));
  const script = resolve("scripts/project.ts");
  try {
    const result = spawnSync(process.execPath, [script, "1", "O'Reilly", "https://bicho.test", "--secret"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const credentials = JSON.parse(readFileSync(resolve(cwd, "_temp/project-1.json"), "utf8"));
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync("migrations/0001_core.sql", "utf8"));
    db.exec(readFileSync(resolve(cwd, "_temp/project-1.sql"), "utf8"));
    const row = db.prepare("SELECT * FROM projects").get();
    assert.equal(row.name, "O'Reilly");
    assert.equal(row.hourly_limit, 1000);
    const limited = spawnSync(process.execPath, [script, "2", "limited", "https://bicho.test", "--hourly-limit=17"], { cwd, encoding: "utf8" });
    assert.equal(limited.status, 0, limited.stderr);
    db.exec(readFileSync(resolve(cwd, "_temp/project-2.sql"), "utf8"));
    assert.equal(db.prepare("SELECT hourly_limit FROM projects WHERE id='2'").get().hourly_limit, 17);
    assert.equal(spawnSync(process.execPath, [script, "3", "invalid", "https://bicho.test", "--hourly-limit=0"], { cwd }).status, 1);
    assert.ok(!("read_token_hash" in row));
    assert.ok(!("read_token" in credentials));
    assert.ok(!("BICHO_ADMIN_TOKEN" in credentials));
    assert.deepEqual(Object.keys(credentials).sort(), ["otlp", "project_id", "sentry"]);
    assert.deepEqual(credentials.sentry, { dsn: `https://${row.public_key}@bicho.test/1`, headers: { "X-Bicho-Secret": credentials.otlp.headers["X-Bicho-Secret"] } });
    assert.equal(row.public_key, credentials.otlp.headers["X-Bicho-Key"]);
    assert.equal(row.secret_hash, createHash("sha256").update(credentials.otlp.headers["X-Bicho-Secret"]).digest("hex"));
    assert.deepEqual(credentials.otlp, {
      endpoint: "https://bicho.test/v1/logs",
      headers: { "X-Bicho-Key": credentials.otlp.headers["X-Bicho-Key"], "X-Bicho-Secret": credentials.otlp.headers["X-Bicho-Secret"] },
    });
    const browserCredentials = JSON.parse(readFileSync(resolve(cwd, "_temp/project-2.json"), "utf8"));
    assert.deepEqual(browserCredentials.sentry, { dsn: `https://${browserCredentials.otlp.headers["X-Bicho-Key"]}@bicho.test/2` });
    assert.deepEqual(browserCredentials.otlp, {
      endpoint: "https://bicho.test/v1/logs",
      headers: { "X-Bicho-Key": browserCredentials.otlp.headers["X-Bicho-Key"] },
    });
    assert.equal(spawnSync(process.execPath, [script, "1", "duplicate", "https://bicho.test"], { cwd }).status, 1);
    assert.equal(spawnSync(process.execPath, [script, "bad", "invalid", "https://bicho.test"], { cwd }).status, 1);
    db.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
