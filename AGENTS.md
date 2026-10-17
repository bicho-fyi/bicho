# Bicho core

## Project

Bicho is a Cloudflare Worker for OTLP and Sentry SDK error ingestion, D1/R2 storage, investigation APIs and MCP tools. Read README.md and relevant source/tests before editing. Use npm and Node 24. Dashboards and SDKs are separate projects; no sibling checkout is required.

- `src/index.ts`: Hono routes, authentication middleware and HTTP policies.
- `src/otlp.ts`: OTLP/HTTP JSON and binary protobuf ingestion.
- `src/sentry.ts`: bounded Sentry envelopes, legacy store requests and ingest authentication.
- `src/core.ts` and `src/investigation.ts`: storage, grouping, project registration and investigation queries.
- `src/mcp.ts`: stateless Streamable HTTP tools using the authenticated API.
- `src/enrichment.ts`: uploaded source maps and bounded background processing.
- `migrations/0001_core.sql`: initial D1 schema. Never reset populated storage to reapply it.
- `test/`: Vitest Node and Workers-runtime checks. `docs/openapi.json`: HTTP contract.

## Guardrails

- For agent-assisted work, commit or push only when the user says "yolo" for that task. Publishing and history rewrites require separate explicit approval.
- Check branch, remotes and changes before staging; preserve unrelated work. Keep scratch files in ignored `_temp/`. Never expose or commit credentials.
- Use local tests by default, including Cloudflare's Vitest plugin. Do not run Wrangler or deploy; hosted verification and live writes require explicit permission. Never fabricate production events.
- Keep changes focused. Reuse existing helpers and platform features; avoid speculative queues, auth frameworks and abstractions with one implementation. Add comments only for non-obvious constraints.

## Core invariants

- Preserve OTLP/HTTP JSON and binary protobuf ingestion at `/v1/logs`, authenticated with `X-Bicho-Key` and optional `X-Bicho-Secret`. Sentry SDK error ingestion is supported through envelope and legacy store endpoints. Project identity must come from authenticated ingest credentials; never trust resource/service attributes, a route project ID or an unvalidated envelope DSN.
- Keep Sentry compatibility as a bounded envelope parser and error-event adapter into the existing normalization, credential filtering, grouping, deduplication, quota and append-only storage pipeline. Reuse project ingest keys, validate credential/project agreement, and keep admin auth separate. Preserve stack frames, breadcrumbs and contexts; honor Sentry event IDs for project-scoped retries. Do not build a second storage backend or change OTLP behavior.
- Scope Sentry compatibility to error events. Tracing, sessions, replay, profiling and attachments remain out of scope; handle unsupported envelope items explicitly without misparsing them or retrying already accepted errors. Verify DSN/auth, CORS, compression, byte limits, mixed envelopes, quotas and deduplication with real SDK requests in Node and Workers-runtime tests. Document tested SDK versions rather than claiming universal Sentry compatibility.
- Ingest credentials authorize ingestion only. Reads and mutations require the Cloudflare secret `env.BICHO_ADMIN_TOKEN`, compared constant-time. Fail closed when it is missing; never store admin tokens in D1. Keep every lookup project-scoped.
- Events are append-only. Resolving, ignoring, muting and reopening change issue status without changing captured evidence. Do not add deletion, retention cleanup or automatic reopening. Unindexed duplicate uploads may be cleaned up.
- MCP tools call the authenticated API, never D1/R2 directly. Only project creation with generated unique numeric IDs and random ingest credentials, and issue-status updates, are permitted mutations. Never replace or delete projects or edit captured events. Keep the official stateless transport without OAuth or session storage.
- Filter credentials before indexing or storing event evidence. Preserve grouping and occurrence-UID deduplication; keep quotas and payload limits enforced under contention.
- Scheduled processing is bounded, idempotent and resumable. Keep enrichment separate from captured data, use uploaded source maps only, and mark incomplete or truncated output. Never store AI-generated diagnoses. Shared admin auth identifies no individual actor.

## Verification and documentation

Run `npm run check` and `npm test` after behavior changes. The suite covers Node and local Workers-runtime behavior; preserve auth separation, project isolation, grouping, retry deduplication and state changes without data loss. Documentation-only edits need `git diff --check`. Report what passed and what was not tested.

Write plain English with sentence-case headings. Keep README examples, MCP schemas and `docs/openapi.json` aligned with actual behavior. Local tests do not prove hosted deployment or scheduled delivery.

Keep the Apache-2.0 license text and copyright attribution intact. Preserve applicable upstream licenses and notices.
