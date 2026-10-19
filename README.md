# Bicho

[![Source version](https://img.shields.io/github/package-json/v/bicho-fyi/bicho)](package.json)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)](package.json)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

Bicho is a self-hosted error tracker on Cloudflare Workers. Send exception and error logs over OTLP/HTTP or from Sentry SDKs, inspect grouped issues through the API or MCP, and keep the captured evidence in your own D1 database and R2 bucket.

It accepts OTLP JSON and binary protobuf logs, plus Sentry error envelopes and legacy store requests. You can use it without a dashboard or an OpenTelemetry Collector.

## SDKs

- [JavaScript / TypeScript](https://github.com/bicho-fyi/bicho-javascript): [`@bicho-fyi/javascript`](https://www.npmjs.com/package/@bicho-fyi/javascript), with automatic browser error capture and explicit backend reporting in Node.js.

You can also keep an existing Sentry SDK and point it at Bicho. For other integrations, use an OpenTelemetry logs exporter with OTLP/HTTP JSON or protobuf.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bicho-fyi/bicho)

The button copies the public repository into your account, provisions D1 and R2, and sets up Workers Builds. Enable R2 in your Cloudflare account first. When prompted for `BICHO_ADMIN_TOKEN`, supply a unique token generated with `openssl rand -hex 32`. Save it for API and MCP access.

The deploy script applies database migrations before deploying the Worker. Your instance is available at its `workers.dev` URL; preview URLs are disabled.

After deployment:

1. Connect your MCP client to `https://<your-worker>/mcp` using the admin bearer token.
2. Call `create_project` with `{ "name": "My app" }`. It creates the database record and returns a generated project ID, OTLP configuration and Sentry DSN. No local SQL or direct database access is needed.
3. Save the returned headers and configure your application's exporter or SDK. Use `secret: true` only for backend projects.

For a custom domain, configure the route and disable `workers_dev` when you no longer need that alternate endpoint. See [Cloudflare's deploy-button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) for platform setup details.

This package contains the Worker source, not a browser SDK or a standalone Node server. Installing it from npm does not create Cloudflare resources; use the deployment flow above to host an instance.

## Local setup

Use Node 24 and npm. The Worker needs the `DB` (D1) and `PAYLOADS` (R2) bindings in `wrangler.jsonc`. Local development uses local storage; replace the placeholder D1 ID before deploying to an existing Cloudflare database.

For local development, copy `.dev.vars.example` to `.dev.vars` and set `BICHO_ADMIN_TOKEN` to a long random token. Use a Cloudflare secret for hosted instances. Never put the token in D1, frontend code or `wrangler.jsonc`. Admin endpoints return 503 if it is missing or empty.

```sh
nvm use
npm ci
npm run check
npm test
npx wrangler d1 migrations apply DB --local
npm run dev
```

Register a project through MCP at `http://localhost:8787/mcp`, or use `POST /api/projects`, with your local admin token.

For offline SQL generation, run `npm run project -- 1 "My app" http://localhost:8787`. It writes SQL and ingest credentials under ignored `_temp/` without connecting to Cloudflare. Apply `_temp/project-1.sql` to the local database before using the generated `otlp.endpoint` and `otlp.headers`.

[project.example.json](project.example.json) and [project.example.sql](project.example.sql) show the generated formats with placeholder credentials. The JSON is not an importable configuration, and editing it does not register a project. Generate your own credentials rather than using the placeholders.

Browser projects use a public ingest key without a secret. `--secret` requires an additional ingest secret for backend clients. Generated OTLP headers contain `X-Bicho-Key` and, when required, `X-Bicho-Secret`. A secret never grants admin access. Do not put it in a browser bundle.

### Manual hosted setup

1. Provision a fresh D1 database and private R2 bucket. The default names in `wrangler.jsonc` are `bicho` for the Worker and database, and `bicho-events` for the bucket. Replace the all-zero D1 ID with your database ID and adjust names as needed, retaining the `DB`/`PAYLOADS` binding names and `nodejs_compat`. The migration command uses the `DB` binding so you can choose a different database name.
2. Keep `migrations_dir` pointed at `migrations`. The deploy script applies `migrations/0001_core.sql` to the database.
3. Configure `BICHO_ADMIN_TOKEN` as a Worker secret. Set `CORS_ORIGINS` only for trusted browser origins; dashboards should keep the admin credential on their server rather than ship it in a public bundle.
4. Deploy through Workers Builds or your CI/CD with `npm run deploy`. Use the `workers.dev` URL or configure a custom domain and disable `workers_dev`. Check that the hourly Cron Trigger is attached.
5. Register a project through MCP or the API on the hosted instance. Local project records are separate from the hosted database.

The initial migration is for a fresh database. Editing it does not upgrade a database where it has already run. Never reset populated storage to reapply it.

## Register a project

On a running local or hosted Worker, call MCP `create_project` with `{ "name": "My app" }`, or send the same JSON to `POST /api/projects` with the admin bearer token. The optional `hourly_limit` accepts an integer from 1 to 1000000 (default 1000). Set `secret: true` to require an additional backend ingest secret.

The API returns HTTP 201 with `{ project: { id, name, hourly_limit }, otlp: { endpoint, headers }, sentry: { dsn, headers? } }`. The server generates a unique numeric-string ID and random ingest credentials. Save the returned headers securely: project listings do not expose credentials, and only the ingest secret's hash is stored. IDs cannot be supplied, and registration never replaces or deletes existing projects. Each call creates a new project, even with the same name; check `list_projects` before retrying after a lost response.

## Move from Sentry

Create a Bicho project through MCP or the API and use its returned `sentry.dsn` in your existing Sentry SDK configuration. You keep your application's error-capture code; Bicho receives and groups the events.

For JavaScript, using your existing `@sentry/browser` or `@sentry/node` import:

```js
Sentry.init({
  dsn: "https://YOUR_PUBLIC_KEY@your-bicho-worker.example/PROJECT_ID",
  tracesSampleRate: 0,
  sendClientReports: false,
});
```

Use the generated DSN rather than the placeholder above. Keep error-capture integrations; remove integrations that send replay, profiling, tracing or structured logs. Bicho stores error/message events, not those other data types. Release, environment, tags, custom fingerprints, stack frames, breadcrumbs and contexts remain available through the same API and MCP tools as OTLP events. This changes where new errors go; it does not import historical Sentry data or reproduce Sentry's grouping rules.

For a secret-enabled backend project, pass the generated `sentry.headers` using the SDK's transport headers. With `@sentry/node`:

```js
Sentry.init({
  dsn: project.sentry.dsn,
  transportOptions: { headers: project.sentry.headers },
  tracesSampleRate: 0,
  sendClientReports: false,
});
```

Browser projects must not require an ingest secret. Keep the admin token out of SDK configuration. For SDKs without custom-header support, use a public-key-only project or a transport that supplies the required backend secret; a DSN alone cannot bypass it.

Bicho accepts `POST /api/:project_id/envelope/` and raw JSON at the legacy `POST /api/:project_id/store/` endpoint. Query authentication (`sentry_version=7&sentry_key=...`), `X-Sentry-Auth`, and self-authenticating envelope DSNs are supported. Supplied credentials must agree with each other and the project. Envelope DSNs must use this installation's origin. Authentication never forwards requests to Sentry.

Requests support gzip and deflate compression via `Content-Encoding`. They are limited to 2 MiB on the wire and after decompression, 1 MiB per error event, 100 envelope items, 32 JSON nesting levels and 20,000 structural values per parsed object. Brotli, zstd, base64-wrapped legacy payloads, minidumps and Sentry artifact-bundle uploads are not supported. Upload source maps through Bicho's authenticated map API; captured frames or `debug_meta.images` must supply matching debug IDs.

Successful responses include `accepted`, `rejected` and `discarded`. Unsupported item types, including attachments and sessions, are skipped and counted in `discarded`; their payloads are not stored. Malformed error events reject the batch before persistence. Quota rejection before acceptance returns 429 with `Retry-After` and `X-Sentry-Rate-Limits`; a storage failure returns 503. After an accepted prefix, Bicho returns 200 and lists rejected IDs so clients do not replay the accepted batch. Standard SDKs may ignore that body and drop the rejected remainder. When explicitly resending individual events, keep their `event_id`; retries deduplicate within a project.

Interoperability tests exercise `@sentry/node` and `@sentry/browser` 11.8.0 serialization and transports, including real HTTP delivery, plus browser-client delivery inside workerd. Compatibility with another SDK depends on its transport and emitted event format.

## OpenTelemetry ingestion

Configure a logs exporter for your application language. With exporters that honor the standard environment variables:

```sh
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://your-bicho-worker.example/v1/logs
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_LOGS_HEADERS=X-Bicho-Key=YOUR_PUBLIC_KEY
```

For a project provisioned with `--secret`, include both headers:

```sh
export OTEL_EXPORTER_OTLP_LOGS_HEADERS="X-Bicho-Key=YOUR_PUBLIC_KEY,X-Bicho-Secret=YOUR_INGEST_SECRET"
```

Use the generated `otlp` object, not these placeholder keys. `http/json` is also supported where the exporter implements it. Use the logs-specific endpoint above so it is used as-is; a generic OTLP base endpoint normally has `/v1/logs` appended by the exporter. Bicho does not accept gRPC, `/v1/traces` or `/v1/metrics`.

Install an OpenTelemetry logs SDK, exporter or logging bridge for your application language. Environment variables configure the exporter; your instrumentation must capture exceptions and emit them as logs. Trace events alone are not enough.

`POST /v1/logs` identifies the project from `X-Bicho-Key`. `service.name` and other resource attributes are metadata, never authentication. Browser keys are public and ingest-only; backend projects may also require `X-Bicho-Secret`. Neither grants read, state-change, map-upload or MCP access. Cross-origin ingestion supports preflight; read/admin CORS remains separate.

The payload must follow OTLP's protobuf JSON mapping or binary protobuf schema. Exceptions use `exception.type`, `exception.message` and `exception.stacktrace` attributes. Bicho accepts exception records regardless of severity, plus plain ERROR/FATAL logs; it rejects other records through partial-success responses rather than acting as a general log archive.

Full success returns HTTP 200 with an empty export response (`{}` for JSON). Partial acceptance returns HTTP 200 with `partialSuccess.rejectedLogRecords` and a diagnostic message. Exporters must not retry a populated partial-success response. A whole-request failure uses the OTLP status shape and the request encoding, not the REST read API's `{error}` shape. Quotas/storage failures can return 429/503 before any accepted records; respect `Retry-After`.

For retry-safe occurrence counts, provide a stable `log.record.uid` attribute for each emitted record and preserve it across retries. Bicho derives a project-scoped event ID from that UID. Without one, Bicho generates an ID and a resent batch can count as new occurrences; trace/span correlation IDs are not deduplication keys. Equal error messages still group into the same issue but represent separate occurrences.

Bicho preserves sanitized resources, instrumentation scopes, timestamp precision and raw stack text. The search index uses millisecond timestamps. Recognized stack formats also produce frames for grouping; other formats remain readable as text. Source-map enrichment needs matching debug IDs, which ordinary OTLP stack attributes do not supply.

Requests are limited to 2 MiB on the wire and after decompression, 100 records per batch, 32 nesting levels and 20,000 structural values. A normalized record is limited to 1 MiB. Invalid known fields reject the batch before storage; ordinary low-severity logs use partial rejection. Derived stacks stop at 200 input lines or 100 recognized frames; the sanitized raw stack remains available.

The bundled OTLP schemas and their upstream licenses are documented in [src/vendor/otlp](src/vendor/otlp/README.md).

### Send a JSON record

Use a dedicated test project for this example and replace the endpoint and key with its generated values. The fixed occurrence UID lets you resend the request to check deduplication without adding another event.

```sh
curl --fail-with-body -sS https://your-bicho-worker.example/v1/logs \
  -H 'Content-Type: application/json' \
  -H 'X-Bicho-Key: YOUR_PUBLIC_KEY' \
  --data-binary '{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"smoke-test"}}]},"scopeLogs":[{"logRecords":[{"severityNumber":17,"body":{"stringValue":"Smoke-test failure"},"attributes":[{"key":"exception.type","value":{"stringValue":"TestError"}},{"key":"log.record.uid","value":{"stringValue":"bicho-otlp-smoke-1"}}]}]}]}]}'
```

Verify the stored event through authenticated issue/event reads, not just HTTP success. Applications may send directly or through an OpenTelemetry Collector; a Collector is optional and is not bundled with Bicho. See the [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) and [exception log conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/).

## API contract and schemas

[docs/openapi.json](docs/openapi.json) documents the HTTP routes, authentication, parameters and response shapes in OpenAPI 3.1.1 format. Import it into your API client and set your deployment hostname. The Worker does not host a documentation UI or serve this file.

MCP tool input schemas use Zod in [src/mcp.ts](src/mcp.ts). An authenticated MCP client receives their JSON Schema through `tools/list`; no separate public schema route is needed. OpenAPI describes the `/mcp` transport, while Zod describes the individual tool arguments. OTLP ingest requires X-Bicho-Key and, for secret-enabled projects, X-Bicho-Secret.

Contract tests compare routes and responses with OpenAPI. The handlers also validate cross-field rules, including time ranges, cursor scope and source-map segments.

To validate the complete document independently, with Python's `uv` available:

```sh
uvx --from openapi-spec-validator openapi-spec-validator docs/openapi.json
```

## Development

Run `npm run check` and `npm test` before submitting changes. Vitest runs Node tests and local Workers-runtime tests with isolated D1/R2 storage. Use `npm run test:node`, `npm run test:workers` or `npm run test:watch` for a narrower run. Tests do not load your `.dev.vars` or contact Cloudflare.

`src/index.ts` owns Hono routes, authentication middleware, CORS, security headers, and HTTP errors. `src/core.ts` owns ingestion, grouping, and storage queries. `src/otlp.ts` owns OTLP ingestion and mapping; `src/http.ts` supplies shared HTTP errors and JSON-object validation. Add routes beside the existing ones, reuse the project/admin-auth middleware, and keep fallback handlers last. Keep every storage lookup project-scoped.

Global headers apply to JSON, streamed R2 payloads, preflights, and errors: restrictive CSP, frame denial, permissions restrictions, MIME sniffing protection, referrer protection, and `no-store`. HTTPS responses receive HSTS for the current host only, without preload or subdomain enforcement. Each response includes a server-generated `X-Request-ID`; internal error logs use that ID and omit credentials, queries, and event bodies.

For a separate dashboard, set `CORS_ORIGINS` in `wrangler.jsonc`, for example `https://dashboard.example.com,http://localhost:5173`. CORS is browser policy, not authorization. The API header policy assumes JSON-only responses; give future HTML routes their own CSP rather than weakening the global policy.

See [AGENTS.md](./AGENTS.md) for contributor guardrails. Ingest credentials never authorize reads or mutations, events are append-only, and MCP tools use the authenticated API.

## HTTP API

Send `Authorization: Bearer <BICHO_ADMIN_TOKEN>` on every read, issue PATCH, source-map PUT and MCP request. The Worker compares SHA-256 digests constant-time; ingest keys and secrets are not admin credentials. REST responses are JSON; errors use `{ "error": "..." }`.

- `GET /api/:project_id/issues`: `{ issues, has_more, next_offset, next_cursor, provenance }`
- `GET /api/:project_id/issues/:id`: `{ issue, events, has_more, next_offset, next_cursor, provenance }`
- `GET /api/:project_id/events/:id`: full event JSON
- `GET /api/:project_id/releases`: `{ releases, next_offset }`, derived from stored events
- `GET /api/projects`: project IDs, names, and hourly quotas, without ingest credentials
- `POST /api/projects`: register a project; returns its generated ID, OTLP credentials and Sentry DSN
- `POST /api/:project_id/envelope/`: ingest Sentry error envelopes
- `POST /api/:project_id/store/`: ingest legacy Sentry error JSON
- `GET /api/:project_id/events`: searchable event metadata
- `GET /api/:project_id/issues/:id/history`: recorded status transitions
- `GET /api/:project_id/stats`: deterministic counts, UTC buckets, breakdowns, and representative event metadata
- `GET /api/:project_id/processing`: project enrichment counts and explicitly global processor health
- `PUT /api/:project_id/sourcemaps/:debug_id`: register an immutable Source Map v3 JSON object
- `GET /api/:project_id/sourcemaps/:debug_id`: source-map metadata, not source contents or storage keys
- `PATCH /api/:project_id/issues/:id`: `{ "status": "resolved" }` returns `{ issue }`

PATCH accepts only `status`: `resolved`, `ignored`, `muted`, or `unresolved` to reopen. It changes no events or payloads. New events do not automatically reopen hidden issues. There are no DELETE endpoints.

Actual status changes record history transactionally; repeated identical PATCH requests add nothing. History actor `admin` means the shared administrator credential, not a named individual.

Lists accept `limit` (1..100, default 50) and `offset` (0..1000000). Issue lists default to `status=unresolved`; another status or `status=all` includes hidden issues. They also accept `q`, `environment`, `release`, `level` and `issue_id`. Event/statistics reads may filter the current issue status but do not default to unresolved. Filters match a stored event in the issue; `event_count` remains the all-time total. IDs and every lookup are scoped to the project. Issue IDs are lowercase SHA-256 fingerprints; event IDs are normalized to 32 lowercase hexadecimal characters on ingestion.

Issue/event investigation reads accept UTC RFC3339 `from` (inclusive), `to` (exclusive), and up to 16 `tag.KEY=value` predicates. All event predicates must match the same event. Event `q` searches the captured message; issue `q` searches its title. Tags are indexed; message search uses bounded-input substring queries, not a full-text index.

Substring search uses SQLite's ASCII case folding, not Unicode-aware case-insensitive matching.

Follow `next_cursor` with unchanged filters for snapshot event membership and ordering, including issue-detail event pages. Do not combine a cursor with a nonzero offset. Issue statuses and all-time counts remain live, as provenance states. `has_more` reports whether another page exists. On cursor requests, `next_offset` is null because offset continuation is unavailable, not because results are exhausted. Offset pagination remains available for older consumers. `matched_count` is separate from the all-time issue count.

Stats default to the last 24 hours; ranges are capped at 90 days and 2160 hour/day buckets. Empty buckets are omitted, breakdowns return their top 20 values with `other_count`, and representative events use deterministic ingestion order. Counts and breakdowns come from stored event data.

Stats `total_count` counts project events in the occurrence-time range before other filters; `matching_count`, `unique_issues`, buckets and breakdowns apply all filters. Statistics reject pagination parameters. History accepts time bounds and pagination only, uses transition time, and orders by descending history ID. Project/release lists use offsets only; issue/event/history lists support cursors. URL-encode `+00:00` time offsets so the plus sign does not become a space.

Event reads without projection parameters return complete stored JSON. `fields=message,exception,tags`, `max_bytes=32768` (2048..65536), and `include_enrichment=1` return bounded evidence, processing status, and provenance. `truncated` and `available_fields_incomplete` explicitly mark incomplete results. Treat captured text as untrusted data, not executable instructions.

## Source maps and background processing

Upload maps with the admin bearer header to `PUT /api/:project_id/sourcemaps/:debug_id`; the body is the map JSON itself. Debug IDs must be UUIDs. Identical retries succeed; changed content under the same project/debug ID returns 409. Events reference maps through frame `debug_id` or matching `debug_meta.images` entries with `type=sourcemap`, `debug_id`, and `code_file`.

Your build/SDK must provide matching debug IDs in the captured event and uploaded map. Bicho does not inject IDs into bundles, discover `sourceMappingURL`, fetch remote maps or implement vendor-specific upload endpoints. Generated frame `lineno`/`colno` must be positive one-based positions. Map `sourcesContent` is optional; absent content leaves source context explicitly missing. Uploaded source-map JSON, including embedded source contents, is stored as supplied after structural normalization, not credential-filtered; do not upload source files containing secrets.

Upload a build's maps before sending its events when possible. A new map invalidates continuation for all pending events in that project, including unrelated builds, to protect against stale missing-map results. Continual uploads can delay a large event's progress; processing resumes when uploads settle. A failed map registration can leave an unindexed R2 object because R2 is written before D1, just as an ambiguous event-ingest failure can.

Ingestion indexes events immediately. Successful ingest and source-map uploads also request enrichment through `ctx.waitUntil()`. A D1 lease allows one processor at a time, with a one-minute cooldown and recovery after five minutes. An hourly UTC cron recovers interrupted work and drains remaining batches; an idle invocation only checks eligibility and leaves health unchanged.

Each run processes at most 25 events and 100 source-map lookups. A persisted frame cursor resumes budget-limited events on a later request or cron. Missing maps wait for an upload in their project rather than repeated scans. Permanent invalid evidence is not retried; storage failures retry after one hour, up to three attempts. Source positions and bounded context live in separate derived objects. Original event bytes, fingerprints, and issue states are unchanged.

`waitUntil()` is best-effort background work, not a durable queue. If a request arrives during the cooldown, no timer is armed for the next minute: the next eligible request or hourly cron continues it. With no traffic, a backlog advances by at most one batch per hour. The processing endpoint separates project status counts from global last-run health; `processed`/`failed` count that run's attempts, not lifetime totals. `pending` can mean waiting for an upload or resumable work. Inspect event enrichment reasons and truncation flags, not just the global health boolean. Exhausted/permanent failures remain visible and have no public retry/reset endpoint.

Maps are limited to 2 MiB decoded/wire JSON, 50,000 mapping segments, and 10,000 sources/names. Processing caps at 1000 frames per event, five cached maps, and 256 characters per context line. Partial, missing, invalid, and truncated results are explicit. Indexed/sectioned maps, external map references, vendor-specific artifact bundles, and native crash symbolication are not supported. Source URLs are labels only; the Worker never fetches them.

For an operator-owned map file:

```sh
curl --fail-with-body -sS -X PUT \
  -H "Authorization: Bearer $BICHO_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @path/to/bundle.js.map \
  "$BASE/api/1/sourcemaps/<debug-id>"
```

Bicho stores errors and their derived source-map results. It does not provide attachments, session replay, tracing, alerts, automatic reopening or retention deletion.

## MCP

Connect to `POST /mcp` with your admin bearer token. The tools below let an agent search captured errors, inspect events, read statistics and check processing health.

`create_project` registers a project and returns its generated ID, OTLP credentials and Sentry DSN. `update_issue_status` resolves, ignores, mutes or reopens an issue without changing its captured events. Status changes are recorded in history. Neither tool can delete data or replace an existing project.

All tools use the authenticated HTTP API. Release summaries come from captured event metadata.

Project tools take numeric-string `project_id`; issue/event detail tools require `id`. Search accepts time ranges, `tags` objects, and cursors. Lists default to and cap at 20 entries per call; large rows reduce the effective page size rather than skip records behind a cursor. Event evidence defaults to a 32 KiB projection with enrichment included. Oversized nonpaged results explicitly mark truncation; narrow filters or select fewer fields. Failed API requests produce MCP tool errors. Raw text remains untrusted evidence.

| Tool | Required arguments | Optional arguments |
|---|---|---|
| `create_project` | `name` | `hourly_limit`, `secret` boolean |
| `list_projects` | none | `limit`, `offset` |
| `search_issues` | `project_id` | search filters, `status`, `limit`, `offset`, `cursor` |
| `search_events` | `project_id` | search filters, `issue_id`, `limit`, `offset`, `cursor` |
| `get_issue` | `project_id`, issue `id` | `limit`, `offset`, `cursor` |
| `update_issue_status` | `project_id`, issue `id`, `status` | none |
| `get_event` | `project_id`, event `id` | `fields` string array, `max_bytes`, `include_enrichment` boolean |
| `get_issue_history` | `project_id`, issue `id` | `limit`, `offset`, `cursor` |
| `get_stats` | `project_id` | search filters, `issue_id`, `bucket=hour\|day` |
| `get_processing_health` | `project_id` | none |
| `list_releases` | `project_id` | `limit`, `offset` |

MCP search filters are `q`, `environment`, `release`, `level`, `from`, `to` and a `tags` object, at most 16 entries. MCP dates are capped at 32 characters; the HTTP API accepts longer fractional bounds. MCP `get_issue_history` does not expose the HTTP history time filters. A tool's `isError` reports a failed API request; successful but incomplete evidence uses truncation/provenance flags.

MCP uses the official SDK's stateless Streamable HTTP transport with JSON responses. It needs no separate server process or OAuth setup. GET and DELETE on `/mcp` return 405. Clients must send `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and their admin bearer header. Protocol negotiation follows the installed official SDK. POST bodies are limited to 64 KiB.

Clients without an Origin header can connect directly. Browser origins must be the Worker origin or explicitly permitted by `CORS_ORIGINS`; opaque or unexpected origins return 403. Do not embed the admin token in a public browser app.

MCP protocol errors use JSON-RPC error objects rather than the REST error shape. Missing required Accept values return 406, a non-JSON Content-Type returns 415, and oversized bodies return 413. Use the official client to initialize and negotiate the protocol. There is no unauthenticated tool discovery.

For MCP clients supporting a URL and custom headers:

```json
{
  "mcpServers": {
    "bicho": {
      "url": "https://your-bicho-worker.example/mcp",
      "headers": { "Authorization": "Bearer <admin-token>" }
    }
  }
}
```

## Storage and quotas

Each project defaults to 1000 new events per UTC hour. Set `hourly_limit` when creating a project through the API or MCP, or pass `--hourly-limit=1000` to the local generator. D1 enforces quotas atomically, including concurrent requests. Duplicate occurrence UIDs do not consume quota; rejections before acceptance return 429 and `Retry-After`.

Known credential keys, Basic/Bearer strings and credential URL/query values are filtered before indexing and storage. This cannot remove arbitrary secrets or PII embedded in prose or source code. Send only data you intend administrators and connected agents to read. Stored evidence is compact and gzip-compressed in R2.

R2 is written before the D1 index. An ambiguous D1 failure can leave an unreferenced object; Bicho retains it rather than risk deleting committed evidence. Grouping uses exception type/message and the most recent recognized stack location. It does not normalize changing IDs/URLs or infer root causes.

## Operations

### Bot and abuse protection

Project IDs and browser ingest keys are public, not bot protection. Ingest quotas cap accepted events, not incoming requests or Worker cost. Configure [Cloudflare WAF and rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) on your production custom domain, scoped to ingest, admin API and MCP paths as needed; available controls depend on your plan. Disable unused `workers.dev` and preview URLs to avoid alternate entry points. Avoid interactive challenges on SDK/API routes: automated clients cannot complete them. Tune limits for legitimate error bursts and shared IPs. This repo does not configure edge rules.

| HTTP status | Meaning |
|---|---|
| 400 | Invalid ID, query, OTLP payload, map, state body or MCP protocol input |
| 401 | Missing/invalid admin token; REST errors include the bearer challenge |
| 403 | Invalid ingest credentials or rejected MCP Origin |
| 404 | Project/resource not found within the requested scope |
| 405 | Method not implemented; GET/DELETE MCP and DELETE event/issue are unsupported |
| 406 | MCP client does not accept both JSON and event-stream media types |
| 409 | An immutable source-map debug ID already has different content |
| 413 | A request or stored-output byte limit is exceeded |
| 415 | Unsupported body compression or MCP Content-Type |
| 429 | Project UTC-hour ingest quota exceeded |
| 500 | Internal read/storage or processing failure |
| 503 | Ingestion unavailable, admin secret unconfigured or indexed payload unavailable |

Cloudflare account and platform limits apply in addition to Bicho's per-project quotas and payload limits.

Monitor `GET /api/:project_id/processing`, Worker error logs and ingestion 429/5xx rates. Logs contain request IDs and error names, not raw captured bodies. Data grows without retention deletion, including separate derived objects and unreferenced uploads retained after ambiguous failures. Configure D1/R2 backups and capacity monitoring yourself; this core provides no cleanup or restore job.

## Acknowledgements

Bicho uses the [OpenTelemetry Protocol (OTLP)](https://opentelemetry.io/docs/specs/otlp/) for error-log ingestion over HTTP JSON and binary protobuf. Vendored schemas and their upstream licenses are listed in [ACKNOWLEDGEMENTS.md](./ACKNOWLEDGEMENTS.md).

## License

Copyright 2026 [Alex Zappa](https://alex.zappa.dev/) ([FreshJuice](https://freshjuice.dev/)). Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
