import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const config = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"));

export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", environment: "node", include: ["test/*.test.js"] } },
      {
        plugins: [cloudflareTest(async () => ({
          main: config.main,
          miniflare: {
            compatibilityDate: config.compatibility_date,
            compatibilityFlags: config.compatibility_flags,
            d1Databases: config.d1_databases.map((db: { binding: string }) => db.binding),
            r2Buckets: config.r2_buckets.map((bucket: { binding: string }) => bucket.binding),
            bindings: { ...config.vars, BICHO_ADMIN_TOKEN: "admin-test-token", TEST_MIGRATIONS: await readD1Migrations("./migrations") },
          },
        }))],
        test: { name: "workers", include: ["test/runtime/*.test.ts"], fsModuleCache: false },
      },
    ],
  },
});
