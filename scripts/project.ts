import { randomBytes, createHash } from "node:crypto";

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const [id, name, origin, ...options]: string[] = process.argv.slice(2);
const quota = options.find(value => value.startsWith("--hourly-limit="));
const hourlyLimit = quota ? Number(quota.slice("--hourly-limit=".length)) : 1000;
try {
  if (!id || !/^[1-9]\d{0,18}$/.test(id) || !name || name.length > 512 || !origin || new Set(options).size !== options.length ||
    options.some(value => value !== "--secret" && !/^--hourly-limit=[1-9]\d{0,6}$/.test(value)) || !Number.isInteger(hourlyLimit) || hourlyLimit > 1000000 || options.length > 2) {
    throw new Error("Usage: npm run project -- <numeric-id> <name> <origin> [--secret] [--hourly-limit=1000]");
  }
  const url = new URL(origin);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Origin must be an HTTP(S) URL without credentials, path, query, or fragment");
  }
  const sqlFile = `_temp/project-${id}.sql`;
  const credentialsFile = `_temp/project-${id}.json`;
  if (existsSync(sqlFile) || existsSync(credentialsFile)) throw new Error("Project files already exist");
  const publicKey = randomBytes(16).toString("hex");
  const secret = options.includes("--secret") ? randomBytes(32).toString("hex") : "";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const sql = `INSERT INTO projects (id, name, public_key, secret_hash, hourly_limit) VALUES (${quote(id)}, ${quote(name)}, ${quote(publicKey)}, ${secret ? quote(hash(secret)) : "NULL"}, ${hourlyLimit});\n`;
  mkdirSync("_temp", { recursive: true, mode: 0o700 });
  writeFileSync(sqlFile, sql, { flag: "wx", mode: 0o600 });
  writeFileSync(credentialsFile, JSON.stringify({
    project_id: id,
    otlp: { endpoint: `${url.origin}/v1/logs`, headers: { "X-Bicho-Key": publicKey, ...(secret ? { "X-Bicho-Secret": secret } : {}) } },
    sentry: { dsn: `${url.protocol}//${publicKey}@${url.host}/${id}`, ...(secret ? { headers: { "X-Bicho-Secret": secret } } : {}) },
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(`SQL: ${sqlFile}\nCredentials: ${credentialsFile}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Project generation failed");
  process.exitCode = 1;
}
