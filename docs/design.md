# RelayForge — Plan & Design (v2.3)

*A production-oriented webhook relay and inspection platform. Built to run at ₹0/month and to be explainable end-to-end in interviews.*

Status: **v2.3 — decisions locked (§12), 10-day target schedule (§11), M0 in progress.** Free-tier facts re-checked 14 Nov 2026. Changelog in §13.

---

## 1. Problem & pitch

Webhooks are fire-and-forget HTTP calls from providers (Stripe, GitHub, Razorpay, Shopify). In practice they fail silently: your server is down during a deploy, a bug returns 500, the provider gives up, and you have no record of what was sent.

**RelayForge sits between the provider and your app.** It:
1. **Receives** every webhook on a stable public URL and acknowledges it only after it is durably stored.
2. **Stores** the raw request byte-for-byte (headers, body, metadata).
3. **Forwards** it to one or more destinations with **retries, exponential backoff, crash recovery and a dead-letter state**.
4. Lets you **inspect and redeliver** any event from a dashboard or the API.

Resume line: *"Built a durable webhook relay with at-least-once delivery: transactional outbox, Postgres queue with SKIP LOCKED and leases, fenced crash recovery, backoff with jitter, inbound de-duplication, Standard-Webhooks-style signing, and SSRF-safe outbound HTTP; deployed at zero cost."*

**Priority order:** delivery engine → security → minimal dashboard → polish.

## 2. Scope

### MVP (must ship)
| # | Feature | Priority |
|---|---|---|
| F1 | **Ingest**: any method on `/in/{slug}`, raw bytes stored, `202` only after commit | P0 |
| F2 | **Inbound idempotency**: per-endpoint dedupe key → duplicates return `200` + same event id, counted not re-forwarded | P0 |
| F3 | **Delivery engine**: transactional outbox, SKIP LOCKED claiming, leases, fenced completion, retry classification, backoff + jitter, `Retry-After`, dead-letter, graceful shutdown | P0 |
| F4 | **Redelivery**: retry a dead delivery / replay an event, without creating duplicates on double-click | P0 |
| F5 | **Outbound signing** (Standard Webhooks algorithm, secret rotation) + stable ids for receiver-side dedupe | P0 |
| F6 | **SSRF-safe HTTP client** (pinned DNS lookup, IP blocklist, no redirects, size/time caps) | P0 |
| F7 | Accounts (email + password, sessions) and API keys | P1 |
| F8 | Inbound signature verification (generic HMAC, Standard Webhooks) + safe storage of invalid-signature events (§7.2) | P1 |
| F9 | Hardening: rate limits, body cap, encrypted secrets, storage guard, retention job | P1 |
| F10 | **Minimal dashboard**: login, endpoints/destinations, event list (polling), event detail + attempt timeline, redeliver button | P1 |
| F11 | Tests (engine invariants), CI, OpenAPI docs, k6 load-test numbers | P1 |

### Later (only after MVP is solid)
SSE live stream · stats charts · bulk-replay UI (API exists in MVP) · Stripe-specific verification preset · per-destination circuit breaker · `relayforge listen` CLI · filters/routing rules.

### Out of scope (stated in README)
Teams/RBAC, billing, multi-region, ordering guarantees, exactly-once delivery (impossible over HTTP — we provide at-least-once + ids for receiver-side dedupe).

## 3. Architecture

```
                 ┌───────────────── one Node process (ROLE=all) ─────────────────┐
 Provider ──────▶│ Ingest route ──BEGIN: insert event + deliveries COMMIT──┐     │
 (Stripe etc.)   │   202 after commit                                      │     │
                 │                                   in-process wake-up ◀──┘     │
                 │ Delivery worker                                              │
                 │   1. claim due rows (FOR UPDATE SKIP LOCKED, set lease)  ────┼──▶ PostgreSQL
                 │   2. send via SSRF-safe client ─────────────────────────────┼──▶ Destination(s)
                 │   3. fenced update: succeeded / retry later / dead          │
                 │ REST API + minimal React SPA (same origin)                   │
                 └──────────────────────────────────────────────────────────────┘
```

**Core decisions (with interview answers):**

- **Postgres is the queue.** The `deliveries` table is the queue; no Redis/RabbitMQ. Fewer moving parts, ₹0, and enqueueing shares a transaction with the write (outbox). Ceiling: thousands of deliveries/minute — plenty here; Kafka/SQS is the documented scale path.
- **One process, two roles.** API and worker run in one process (`ROLE=all`) because the free tier gives one small instance and because an in-process wake-up signal lets the worker sleep without polling the database (§4.6). The code keeps them separable (`ROLE=api|worker`).
- **Raw bytes in, raw bytes out.** We never re-serialize the body, which keeps the provider's original signature (e.g. GitHub's `X-Hub-Signature-256`) valid at the destination.
- **Same-origin SPA.** Fastify serves the built React app, so the session cookie is first-party; no CORS, no third-party-cookie issues.
- **No ordering guarantee.** Retries and fan-out mean events can arrive out of order — the same contract Stripe and GitHub give. Documented, not hidden.

## 4. Delivery engine (the heart of the project)

### 4.1 Delivery state machine
```
          claim                    2xx
pending ───────▶ in_flight ───────────────▶ succeeded
   ▲                │  retryable & attempts left
   └────────────────┤
     (next_attempt_at = now + backoff)
                    │  non-retryable, or attempts exhausted
                    └──────────────────────▶ dead (dead_reason)

in_flight with expired lease ──(becomes due again)──▶ re-claimed
```
Anything that won't be retried is `dead`, with a `dead_reason` (`exhausted`, `non_retryable_status`, `redirect`, `ssrf_blocked`, `destination_disabled`).

### 4.2 Ingest = transactional outbox
In **one transaction**:
1. Insert the event (with dedupe handling, §5.1).
2. Insert one `deliveries` row per enabled destination (`status='pending'`, `next_attempt_at=now()`) — **skipped when the signature is invalid** (§7.2).
3. Commit → **then** respond `202 { eventId }` → then signal the worker in-process.

Rule: **never acknowledge before commit.** If the process dies before commit, the provider sees an error and retries; if it dies after commit, the delivery rows already exist and the worker picks them up.

Endpoints with zero destinations still store events (inspection-only mode). A **paused** endpoint keeps accepting and storing; its deliveries are held (the claim query skips them) and flow when resumed — pause means *hold*, never *drop*.

### 4.3 Claiming with SKIP LOCKED + leases
Design sketch (not final code):
```sql
WITH due AS (
  SELECT d.id FROM deliveries d
  JOIN destinations ds ON ds.id = d.destination_id AND ds.enabled
  JOIN endpoints e     ON e.id  = ds.endpoint_id   AND NOT e.paused
  WHERE d.status IN ('pending','in_flight') AND d.next_attempt_at <= now()
  ORDER BY d.next_attempt_at
  LIMIT $batch
  FOR UPDATE OF d SKIP LOCKED
)
UPDATE deliveries d
SET status = 'in_flight',
    attempt_count   = d.attempt_count + 1,
    lease_owner     = $workerId,
    next_attempt_at = now() + $lease   -- the lease IS next_attempt_at
FROM due WHERE d.id = due.id
RETURNING d.*;
```
- **SKIP LOCKED** lets concurrent claimers take disjoint rows without blocking each other.
- **The lease is stored as `next_attempt_at`**: an `in_flight` row whose worker crashed becomes due again when the lease expires — no sweeper job.
- **Lease (60 s) > max request time (15 s).**
- **Attempts are counted at claim time** → a payload that crashes the worker still exhausts its budget (poison-message protection).
- **No transaction or row lock is held during the HTTP call.**

### 4.4 Fenced completion
Completion runs in one transaction guarded by a fencing token:
```
UPDATE deliveries SET … WHERE id = $id AND lease_owner = $workerId AND attempt_count = $claimedAttempt
```
If the lease expired and another worker re-claimed the row, 0 rows match and the stale result is discarded (the attempt is still logged).

### 4.5 Retry policy
| Outcome | Classification |
|---|---|
| 2xx | success |
| 408, 429, 5xx, timeout, DNS/connect/TLS/reset errors | **retryable** |
| 3xx | dead (`redirect`) — redirects are never followed |
| other 4xx | dead (`non_retryable_status`) |
| blocked by SSRF guard | dead (`ssrf_blocked`) |

Backoff: `delay = random(0, min(cap, base × 2^(attempt−1)))` (**full jitter**). **Locked defaults: base 30 s, cap 1 h, 10 attempts (worst case ≈ 3 h)**, configurable per destination (max 15). `Retry-After` honoured, clamped to the cap.

### 4.6 Scheduling without burning free-tier DB compute
The worker sleeps until the earliest of: an **in-process signal** (ingest, redelivery, endpoint resumed, destination re-enabled) or the **earliest `next_attempt_at`** among active rows. Nothing pending → sleep indefinitely, so Neon can scale to zero. One catch-up claim on startup.

### 4.7 Dispatcher details
- Bounded concurrency (default 8, small built-in semaphore).
- Timeouts: connect 5 s, total = destination `timeout_ms` (default 10 s, max 15 s).
- Read ≤ 4 KB of response body, then abort; response headers capped.
- Forwarded headers: original **minus** hop-by-hop/sensitive (`Host`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Proxy-*`, `Content-Length` (recomputed), `Cookie`) **plus** RelayForge headers (§5.2, §7.2).

### 4.8 Graceful shutdown
`SIGTERM`: stop claiming → wait for in-flight (≤ timeout) → exit. Anything cut off is recovered by lease expiry.

### 4.9 Redelivery (manual)
- Retry/replay creates a **new** delivery row (`trigger='manual'`, `replay_of` → original).
- Partial unique index: at most one *active* delivery per (event, destination) → second request returns `409` with the existing id.
- **Events with `signature_status='invalid'` can never be replayed** (`422`).
- Bulk redeliver-dead is an API endpoint in MVP, processed in batches.

### 4.10 Engine invariants — the test suite proves these
1. Every stored *valid* event has a delivery row for every destination enabled at ingest time.
2. With N concurrent claimers and no crashes, each delivery is sent exactly once.
3. A delivery whose worker died mid-request is retried after lease expiry.
4. A stale worker can't overwrite a newer result.
5. No delivery stays `in_flight` longer than lease + one scheduling cycle.
6. A crash-inducing payload ends `dead`, not in an infinite loop.
7. Retry classification and backoff bounds match §4.5 (injectable clock + random source).
8. An invalid-signature event never produces a delivery or outbound request.

Tested against a **chaos receiver** (500s, 429 + `Retry-After`, hangs, resets, redirects, "200 after N failures").

## 5. Idempotency & duplicates

### 5.1 Inbound
- Per-endpoint **dedupe source**: a header (e.g. `X-GitHub-Delivery`) **or** a top-level JSON field.
- Partial unique index `(endpoint_id, dedupe_key) WHERE dedupe_key IS NOT NULL`.
- `ON CONFLICT … DO UPDATE SET duplicate_count = duplicate_count + 1, last_duplicate_at = now() RETURNING id, (xmax = 0) AS inserted`.
- **Duplicate →** `200 { eventId, duplicate: true }`, no new deliveries.
- **No dedupe key →** every request is new. No body-hash dedupe (identical payloads can be distinct events).
- Dedupe window = retention. Documented trade-off.
- Invalid-signature requests are **not** entered into the dedupe index (an attacker must not be able to "reserve" a real event id by sending a forged request first).

### 5.2 Outbound
| Header | Value | Purpose |
|---|---|---|
| `X-RelayForge-Id` | event id — same across retries, fan-out, replays | receiver dedupe key |
| `X-RelayForge-Delivery-Id` | delivery id | debugging |
| `X-RelayForge-Attempt` | attempt number | observability |
| `X-RelayForge-Replay` | `true` on manual redeliveries | receiver may re-process |
| `X-RelayForge-Timestamp` / `X-RelayForge-Signature` | §7.2 | authenticity |

README contract: *at-least-once; de-duplicate on `X-RelayForge-Id`.*

### 5.3 Operator actions
Idempotent through the active-delivery unique index (§4.9).

## 6. Data model (PostgreSQL)

```
users             (id, email UNIQUE (lower-cased), password_hash, created_at)
sessions          (id, user_id, token_hash UNIQUE, expires_at, created_at, last_seen_at)
api_keys          (id, user_id, name, prefix UNIQUE, secret_hash, last_used_at, revoked_at, created_at)

endpoints         (id, user_id, slug UNIQUE, name, paused,
                   verify_scheme [none|hmac|standard_webhooks],
                   verify_header, verify_prefix, verify_encoding [hex|base64], verify_secret_enc,
                   dedupe_source [none|header|json_field], dedupe_name,
                   created_at)

destinations      (id, endpoint_id, url, enabled, timeout_ms, max_attempts,
                   signing_secret_enc, prev_signing_secret_enc, prev_secret_expires_at,
                   created_at)

events            (id, endpoint_id, method, path, query, headers JSONB, body BYTEA,
                   body_truncated, content_type, size_bytes, source_ip,
                   dedupe_key, duplicate_count, last_duplicate_at,
                   signature_status [not_checked|valid|invalid], signature_failure_reason,
                   received_at)
  UNIQUE (endpoint_id, dedupe_key) WHERE dedupe_key IS NOT NULL
  INDEX  (endpoint_id, received_at DESC, id DESC)
  INDEX  (received_at) WHERE signature_status = 'invalid'     -- fast short-retention cleanup

deliveries        (id, event_id, destination_id,
                   status [pending|in_flight|succeeded|dead], dead_reason,
                   trigger [auto|manual], replay_of,
                   attempt_count, max_attempts, next_attempt_at, lease_owner,
                   last_status_code, last_error, completed_at, created_at, updated_at)
  INDEX  (next_attempt_at) WHERE status IN ('pending','in_flight')
  UNIQUE (event_id, destination_id) WHERE status IN ('pending','in_flight')
  INDEX  (event_id)

delivery_attempts (id, delivery_id, attempt_no, worker_id, started_at, duration_ms,
                   status_code, response_headers JSONB, response_body_snippet,
                   error_code, error_message)
```
- IDs: UUIDv7, generated in the app (so ids are known before the insert and do not depend on the Postgres version).
- Cascading deletes from events. `max_attempts` snapshotted per delivery.

## 7. Security design

### 7.1 SSRF
- Validate at creation **and** at send time (DNS rebinding).
- **Pinned lookup:** `node:https`/`node:http` with a custom `lookup` that rejects if *any* resolved address is blocked and connects only to vetted addresses.
- **Blocklist (`net.BlockList`):** IPv4 `0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4`; IPv6 `::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8`, `::ffff:0:0/96` (check embedded IPv4), `64:ff9b::/96`.
- `https` only in production; ports 443 or ≥ 1024; no redirects; no URL credentials.
- Dev-only `ALLOW_PRIVATE_DESTINATIONS=true` (refused in production).

### 7.2 HMAC signing, verification, and invalid-signature storage
**Outbound** — Standard Webhooks algorithm under `X-RelayForge-*` names: signed content `{id}.{timestamp}.{raw body}`, base64 HMAC-SHA256, `v1,<sig>`, `whsec_` secrets, space-separated signatures during rotation. **Timestamp set per attempt.** Previous secret kept 24 h after rotation.

**Inbound** (optional per endpoint): `hmac` (header, prefix, hex/base64, over raw bytes) or `standard_webhooks` (300 s tolerance). `crypto.timingSafeEqual` after a length check.

**Invalid-signature policy (locked decision):** store for debugging, **never forward**, and keep storage bounded:
| Control | Rule |
|---|---|
| Response | `401` (same body whatever the failure reason) |
| Forwarding | No delivery rows created; replay refused (`422`); invariant #8 tested |
| Metadata stored | `signature_status='invalid'`, `signature_failure_reason` (`missing_header`, `malformed`, `mismatch`, `timestamp_out_of_tolerance`), headers, size, source IP |
| Body stored | First **64 KB** only (`body_truncated=true` if cut) — enough to debug a mismatch |
| Rate limit | Separate, stricter bucket per endpoint (default 10/min). Over the limit → `401` **without storing**; only a counter is incremented |
| Retention | **24 h** (valid events: 7 days) |
| Dedupe | Never inserted into the dedupe index (§5.1) |
| Dashboard | Shown with a clear "signature invalid — not forwarded" badge and the failure reason; the expected signature is **never** shown (it would leak an oracle) |

### 7.3 Authentication
- **Passwords:** argon2id (`@node-rs/argon2`, N-API prebuilt binaries) with OWASP minimum parameters (19 MiB, 2 iterations, parallelism 1); scrypt rejected because OWASP's parameters need ~128 MiB per hash.
- **Sessions:** 32 random bytes in `__Host-rf_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`); store only SHA-256(token); new token on login; 7-day sliding expiry.
- **CSRF:** SameSite=Lax + Origin header check on state-changing requests.
- **Login hardening:** per-IP/per-email limits, generic errors, dummy hash on unknown email.
- **API keys:** `rf_live_<prefix>_<secret>`, stored as prefix + SHA-256(secret) (high-entropy secret → fast hash is correct).
- **Tenant isolation:** every query scoped by `user_id`; cross-tenant access returns `404`.
- Ingest slugs: 128-bit random capability URLs.

### 7.4 Secret encryption at rest
- **Hashed:** passwords, session tokens, API key secrets. **Encrypted:** inbound verification secrets, outbound signing secrets.
- AES-256-GCM, random 12-byte IV, `v1:<keyId>:<iv>:<ciphertext>:<tag>`, **AAD = table + column + row id**.
- Keyring `ENCRYPTION_KEYS` + `ENCRYPTION_ACTIVE_KEY_ID` for rotation.
- pino `redact` for `authorization`, `cookie`, signature headers, secret fields.

### 7.5 Abuse limits
- **Body cap 1 MB** (`413`). Per-endpoint ingest token bucket (in-memory; single instance). `429` + `Retry-After`.
- **Storage guard:** hourly `pg_database_size()`; above 90 % of the Neon cap → ingest `503` + `Retry-After`.
- `@fastify/helmet` CSP for the SPA.

## 8. Operations

### 8.1 Ingest responses
| Situation | Response |
|---|---|
| Stored | `202 { eventId }` |
| Duplicate | `200 { eventId, duplicate: true }` |
| Unknown slug | `404` |
| Invalid signature | `401` (stored per §7.2 limits, never forwarded) |
| Too large / rate limited / storage nearly full | `413` / `429` / `503` (+ `Retry-After`) |

### 8.2 Observability
pino JSON logs with request/delivery ids; `/healthz` (process up, no DB); `/readyz` (DB reachable — not for keep-alive pings, so Neon can sleep); `/api/v1/stats`.

### 8.3 Retention
Startup + every 24 h, batches of 500: delete **valid** events older than **7 days** and **invalid-signature** events older than **24 h**, only when all deliveries are terminal.

## 9. Tech stack (locked)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Node.js 24 LTS** (`>=24.15`) | Maintenance LTS, supported to 30 Apr 2028 (past this project's lifetime). Pinned via `.nvmrc`, `engines`, Docker base image (`node:24-*`), CI |
| TypeScript execution | **Node's built-in type stripping** (on by default in 24, no warning; verified on v24.15.0) | No `tsx`, no build step for the server. Rules: erasable syntax only (no `enum`, `namespace` with values, parameter properties), `import type`, `.ts` extensions in imports, no `paths` aliases. `tsc --noEmit` type-checks in CI |
| Language | TypeScript (strict) | |
| HTTP | Fastify 5 | + `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/swagger` (added when needed) |
| Validation | Zod | config now; routes via Fastify type provider from M1 |
| DB | PostgreSQL + Drizzle ORM (+ raw SQL for claiming) + `pg` | Drizzle Kit migrations |
| Outbound HTTP | `node:https` / `node:http` with custom `lookup` | no HTTP client library |
| Crypto | `node:crypto` + `@node-rs/argon2` | |
| Frontend (M4) | React + Vite 8 + TanStack Query + Tailwind | |
| Logging | pino (built into Fastify) | |
| Tests | Vitest; integration tests on real Postgres | |
| Load test | k6 | |
| CI | GitHub Actions | |
| Local dev | Windows + VS Code; Postgres via Docker Desktop (WSL 2) | `.gitattributes` forces LF |
| Repo | GitHub `relayforge` (public), npm workspaces | |

**Node 24 compatibility check (14 Nov 2026):**
- Type stripping verified on v24.15.0: `process.features.typescript` is `"strip"`; a `.ts` file with `import type` and interfaces runs with no flag and no warning; an `enum` is rejected at load time. That rejection is what we want: it enforces the erasable-syntax rule at runtime, not only in `tsc`.
- Declared `engines` on npm: Vitest 5 `^22.12 || ^24 || >=26`, Vite 8 `^20.19 || >=22.12`, `pg` `>=16`, `@node-rs/argon2` `>=10` (N-API, ABI-stable across Node majors), TypeScript `>=16.20`.
- Fastify 5 (+ `@fastify/*` plugins), Zod, Drizzle ORM/Kit, pino, React, TanStack Query and Tailwind declare no `engines` field; all are pure JavaScript and support every current LTS line, including 24.
- M0 still runs the installed tree with `node --trace-deprecation` once, to catch surprises.

**Upgrade path:** moving to Node 26 later is a one-line change in `.nvmrc`, `engines`, Dockerfile and CI; it needs no code changes because we use only erasable syntax.

## 10. Deployment at ₹0/month (no credit card)

| Order | Option | Facts | Notes |
|---|---|---|---|
| **1** | **Northflank Developer Sandbox** + Neon | Sandbox: 2 services, 2 jobs, 1 database, ≤ $20/mo resources, always on. Pricing page says "No card needed"; some reviews say a card is required | **Use only if signup completes without a card** (checked in M0). Second service hosts the public chaos receiver |
| **2** | **Render Free** + Neon | No card; sleeps after 15 min idle, ~1 min to wake; 750 instance-hours/month | Trade-offs documented: first webhook after idle can hit the provider's timeout and rely on its retry; the worker sleeps too, so scheduled retries run late after idle periods. Never use Render's free Postgres (expires) |
| Not used | Koyeb (card + $29 hold), Oracle (card) | — | — |

**Database: Neon Free** (no card): 100 CU-hours/project/month, 1 GB storage/project, 5 GB egress; scale-to-zero after 5 min; resumes in a few hundred ms; pooled endpoint = PgBouncer transaction mode (no LISTEN/NOTIFY). App uses the pooled URL; migrations use the direct URL. App and DB in the same region.

**Portability:** one Dockerfile (`PORT`, binds `0.0.0.0`), env-only config, `pg_dump`-able DB.

## 11. Roadmap (10-working-day target at 6–8 h/day; realistic range 10–12)

Scope is unchanged from §2. The 10-day target works because **quality work happens inside each milestone instead of at the end**: CI and `npm run check` exist from M0, each milestone ships with its own tests, and OpenAPI docs come from the Zod route schemas as each route is built. The core work keeps its time: the delivery engine gets ~4 days (3 build + 1 reliability), security + integration gets 2.

| Day | Milestone | Deliverable |
|---|---|---|
| 1 | **M0 Foundation** | Repo, workspaces, TS (type stripping), lint/format, Docker Postgres, Drizzle wiring, CI, Dockerfile, `/healthz`, `/readyz`, config validation, graceful shutdown |
| 2 | **M1 Capture (a)** | Full schema + migrations, users + sessions, endpoints/destinations API |
| 3 | **M1 Capture (b)** | Ingest (raw body, outbox, `202` after commit), inbound dedupe, events API, integration tests |
| 4 | **M2 Engine (a)** | Chaos receiver + invariant tests written first (failing); claim with SKIP LOCKED, lease, fenced completion |
| 5 | **M2 Engine (b)** | SSRF-safe client, retry classification, backoff + full jitter, `Retry-After`, dead-letter |
| 6 | **M2 Engine (c)** | Wake-up scheduler (§4.6), graceful shutdown, redelivery (`409` on duplicate active delivery), outbound signing + secret rotation |
| 7 | **M2 Reliability** | All §4.10 invariants green; concurrency (N claimers), crash/lease-expiry, stale-worker and poison-payload tests against the chaos receiver; review + fixes |
| 8 | **M3 Security (a)** | Inbound verification + invalid-signature policy (invariant #8), encryption keyring, API keys |
| 9 | **M3 Security (b) + Integration** | Rate limits, Origin check, storage guard, retention job; end-to-end suite (ingest → deliver → redeliver, invalid-signature path, tenant isolation); first k6 run |
| 10 | **M4 Dashboard + M6 Ship** | Minimal dashboard (login, endpoints/destinations, event list, event detail + attempts, redeliver); deploy; README |
| 11–12 | **Buffer (if needed)** | Dashboard polish, final k6 numbers, `/api/v1/stats`, ADRs, chaos receiver demo, log review |

**Slip rule:** 10 days is a target, not a hard deadline. If work runs over, the slip moves M4/M5/M6 polish into days 11–12. It never shortens Days 4–9 or removes tests. A milestone is done only when its tests pass, whatever the calendar says.

## 12. Decisions log (locked 14 Nov 2026)

| # | Decision | Choice |
|---|---|---|
| D1 | Runtime | Node.js 24 LTS (`>=24.15`), built-in type stripping; Node 26 is a later, optional upgrade (revised in v2.3) |
| D2 | Code location | Local Windows dev (VS Code); GitHub repo `relayforge` |
| D3 | Hosting | No credit card: Northflank Sandbox if signup needs no card, else Render Free; Neon for the database. **Day 10: Northflank sign-in could not be completed → Render Free (Singapore) + Neon (Singapore)**; free-tier trade-offs in `docs/deploy.md` |
| D4 | Defaults | 7-day retention, 1 MB body cap, 10 attempts with exponential backoff + full jitter (base 30 s, cap 1 h) |
| D5 | Invalid signatures | Store event + validation metadata, never forward; bounded by 64 KB body, stricter rate limit, 24 h retention, no dedupe entry, no replay (§7.2) |
| D6 | Way of working | Small daily milestones; tests written alongside each feature; `npm run check` before every commit |
| D7 | Schedule | 10-working-day target, not a hard deadline (realistic 10–12); slip goes to polish (M4/M5/M6), never to the engine, security or tests (§11) |

Resolved in M0: **Postgres 17** on Neon and locally (Neon supports 14–18). Changed on Day 10 to **Postgres 18** (the Neon project was created on 18; local and CI follow); UUIDv7 ids generated in the app.

## 13. Changelog

**v2.3 (14 Nov 2026):** runtime Node 26 → **Node 24 LTS** (developer's choice; v24.15.0 installed). Type stripping verified on 24; dependency compatibility re-checked (§9). D1 updated. No architecture or scope change.

**v2.2 (14 Nov 2026):** schedule 14 → 10-working-day target (§11), no scope or architecture change. Quality work moved inside each milestone; engine keeps ~4 days including a dedicated reliability day; security + integration keeps 2 days; buffer days 11–12 and slip rule added. Decision D7 added.

**v2.1 (14 Nov 2026):** decisions locked (§12). Node 24 → **26 LTS** with built-in type stripping (no `tsx`/build step) and a compatibility check. Hosting: no-card rule → Northflank if possible, else Render. Invalid-signature policy specified (§7.2): 64 KB body cap, separate rate limit, 24 h retention, no dedupe entry, no replay, invariant #8. Roadmap now states who writes what.

**v2 (14 Nov 2026):** delivery-engine section (leases as `next_attempt_at`, attempts counted at claim, fencing, graceful shutdown, invariants); idempotency section; security rewrite (pinned-lookup SSRF, Standard Webhooks signing, hashed session tokens, AES-GCM with AAD + keyring); dashboard reduced; Koyeb dropped for Northflank + Neon.

**v1 (14 Nov 2026):** initial plan.
