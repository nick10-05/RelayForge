<h1 align="center">RelayForge</h1>

<p align="center">
  <strong>A durable webhook relay. Nothing a provider sends you gets lost, and every delivery is on the record.</strong>
</p>

<p align="center">
  <a href="https://github.com/nick10-05/RelayForge/actions/workflows/ci.yml"><img src="https://github.com/nick10-05/RelayForge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Node.js-24_LTS-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 18">
  <img src="https://img.shields.io/badge/hosting-%E2%82%B90%2Fmonth-34D399" alt="Runs at ₹0 a month">
</p>

---

## The problem

Webhooks from Stripe, GitHub, Razorpay or Shopify are fire-and-forget HTTP calls. If your server is mid-deploy, or a bug returns `500`, the provider retries a few times, gives up, and you are left with no record of what was sent.

**RelayForge sits between the provider and your app.** It:

1. **Receives** every webhook on a stable URL and acknowledges it only after it is safely in the database.
2. **Stores** the raw request byte for byte, so the provider's own signature still verifies at your end.
3. **Forwards** it to one or more destinations with retries, exponential backoff, crash recovery and a dead-letter state.
4. Lets you **inspect and redeliver** any event from a dashboard or the API.

## How it works

```mermaid
flowchart LR
    P([Provider<br/>Stripe · GitHub · …]) -->|POST /in/slug| I[Ingest route]
    subgraph RF [One Node.js process]
        I -->|"one transaction:<br/>event + delivery rows"| DB[(PostgreSQL)]
        I -.->|"202 only after commit"| P
        I -.->|in-process wake-up| W[Delivery worker]
        W -->|"claim due rows<br/>FOR UPDATE SKIP LOCKED + lease"| DB
        W -->|"fenced result:<br/>succeeded · retry · dead"| DB
        API[REST API + React dashboard] -->|"inspect · redeliver"| DB
    end
    W -->|SSRF-safe, signed HTTPS| D([Your destinations])
```

**Postgres is the queue.** The `deliveries` table *is* the job queue. Writing the event and enqueueing its deliveries happen in the same transaction (a transactional outbox), so an event can never be stored without its deliveries, or the other way round. No Redis, no RabbitMQ, nothing extra to run or pay for.

### Every delivery follows one state machine

```mermaid
stateDiagram-v2
    direction LR
    [*] --> pending
    pending --> in_flight: claimed (lease set)
    in_flight --> succeeded: 2xx
    in_flight --> pending: retryable, attempts left (backoff)
    in_flight --> dead: non-retryable or exhausted
    in_flight --> in_flight: lease expired, re-claimed
    succeeded --> [*]
    dead --> [*]
```

| Outcome | What happens |
|---|---|
| `2xx` | succeeded |
| `408`, `429`, `5xx`, timeout, DNS / connect / TLS / reset errors | retried, with `Retry-After` honoured |
| `3xx` | dead (`redirect`). Redirects are never followed |
| any other `4xx` | dead (`non_retryable_status`) |
| blocked by the SSRF guard | dead (`ssrf_blocked`) |

Backoff is `random(0, min(1 h, 30 s × 2^(attempt−1)))` with **full jitter**, and 10 attempts by default (about 3 hours worst case), configurable per destination.

## What makes it reliable

- **Acknowledge only after commit.** A crash before the commit makes the provider retry; a crash after it leaves the delivery rows in place for the worker.
- **`SKIP LOCKED` claiming.** Concurrent workers take disjoint rows without blocking each other.
- **The lease is `next_attempt_at`.** If a worker dies mid-request, its row simply becomes due again. No sweeper job is needed.
- **Fenced completion.** A result is written only if the worker still holds the lease *and* the attempt number matches, so a slow, stale worker cannot overwrite a newer result.
- **Poison-payload protection.** Attempts are counted when a row is claimed, so a payload that crashes the worker still runs out of attempts and ends `dead` instead of looping forever.
- **No lock is held during the HTTP call**, and `SIGTERM` drains in-flight work before exiting.
- **The worker sleeps** until the next due row or an in-process signal, so the free database can scale to zero.
- **Pause means hold, never drop.** A paused endpoint keeps storing events and delivers them on resume.

### Guarantees, stated plainly

**At-least-once delivery.** Exactly-once is impossible over HTTP, so every attempt, retry, fan-out and replay carries the same `X-RelayForge-Id`. De-duplicate on it. Events can arrive **out of order**, which is the same contract Stripe and GitHub give.

| Outbound header | Purpose |
|---|---|
| `X-RelayForge-Id` | Event id, identical across retries and replays: your dedupe key |
| `X-RelayForge-Delivery-Id` / `X-RelayForge-Attempt` | Debugging and observability |
| `X-RelayForge-Replay` | `true` on manual redeliveries |
| `X-RelayForge-Timestamp` / `X-RelayForge-Signature` | Authenticity (Standard Webhooks algorithm) |

## Security

- **SSRF-safe outbound client** built on `node:https` with a pinned DNS lookup. Every resolved address is checked against a blocklist of private, loopback, link-local and other internal IPv4 and IPv6 ranges. URLs are checked at creation *and* at send time to stop DNS rebinding. No redirects, and size and time caps on every request.
- **Outbound signing** with the Standard Webhooks algorithm (HMAC-SHA256) and zero-downtime secret rotation.
- **Inbound verification** (generic HMAC or Standard Webhooks) using constant-time comparison. Forged requests get `401`, are stored briefly for debugging (64 KB, 24 h, their own stricter rate limit), and are **never forwarded or replayable**.
- **Inbound de-duplication** on a header or JSON field. A duplicate gets `200` with the original event id and is counted, not re-sent.
- **Accounts:** argon2id passwords, hashed session tokens in `__Host-` cookies, CSRF origin checks, login rate limits, and scoped API keys.
- **Secrets at rest:** AES-256-GCM with per-row authenticated data and a rotatable keyring. Secrets are redacted from logs, and a test checks it.
- **Tenant isolation:** every query is scoped to its owner, and cross-tenant access returns `404`.
- **Abuse limits:** 1 MB body cap, per-endpoint token-bucket rate limits, a storage guard that returns `503` before the free database fills up, and automatic retention cleanup.

## Tested like it matters

**44 test files (542 tests)** run in CI, and the integration tests use a **real PostgreSQL 18**, not mocks. Server line coverage is **about 95%** (`npm run test:coverage`); what's left is mostly entry points and the real-DNS resolver. They include:

- **Engine invariants** ([`invariants.test.ts`](apps/server/src/delivery/invariants.test.ts)): N concurrent workers send each delivery exactly once; a worker that dies mid-request is recovered after its lease expires; a stale worker cannot overwrite a newer result; a crash-inducing payload ends `dead`; a forged event never causes an outbound request.
- **Reliability under load** ([`reliability.test.ts`](apps/server/src/delivery/reliability.test.ts)): 4 schedulers × 8 slots, and 12 tight-batch workers racing the claim and the reaper, with no double sends and nothing stuck. Also covers a crash between send and completion.
- **End-to-end flows** ([`flows.test.ts`](apps/server/src/e2e/flows.test.ts)) over real HTTP: ingest → fail → retry → succeed (signed, same id), dead → fix → manual retry (double-click safe), forged requests, duplicates, pause/resume, API keys, rate limits, body cap and CSRF.
- A **chaos receiver** that returns `500`s, `429` with `Retry-After`, hangs, connection resets, redirects, and "200 after N failures".

Every push runs format check → lint → type-check → tests → dashboard build → Docker image build.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS, running TypeScript directly with built-in type stripping (no build step for the server) |
| HTTP | Fastify 5, Zod schemas, `@fastify/helmet` |
| Data | PostgreSQL 18, Drizzle ORM and migrations, raw SQL for claiming |
| Outbound HTTP | `node:https` with a custom `lookup` (no HTTP client library) |
| Crypto | `node:crypto`, `@node-rs/argon2` |
| Dashboard | React 19, Vite 8, TanStack Query, Tailwind CSS 4 |
| Quality | Vitest, ESLint, Prettier, GitHub Actions, k6 load script |
| Hosting | One Docker image on Render Free + Neon Postgres: **₹0 a month, no card** |

## Run it locally

You need **Node.js 24.15+** and **Docker**.

```bash
git clone https://github.com/nick10-05/RelayForge.git
cd RelayForge
npm ci
cp .env.example .env            # PowerShell: Copy-Item .env.example .env

# Generate an encryption key and paste it into ENCRYPTION_KEYS in .env
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"

npm run db:up                   # Postgres 18 in Docker (localhost:5433)
npm run db:migrate
npm run dev                     # API + delivery worker on http://localhost:3000
npm run dev:web                 # dashboard (Vite dev server), in a second terminal
```

Before every commit: `npm run check` (format, lint, type-check, all tests).

**API docs:** interactive OpenAPI 3.1 docs at [`/api/v1/docs`](https://relayforge-r0l7.onrender.com/api/v1/docs) (spec at `/api/v1/docs/json`), generated from the same Zod schemas the server validates with.

**A destination that misbehaves on purpose:** `node apps/server/src/testing/chaos-cli.ts 4100` starts the chaos receiver locally. Set `ALLOW_PRIVATE_DESTINATIONS=true` in `.env` to point a destination at it (this is refused in production).

**Load test:** `k6 run load/ingest.js` (see the comments in the file for rate, duration and fan-out options).

## Deploy

**Live:** [relayforge-r0l7.onrender.com](https://relayforge-r0l7.onrender.com) (Render Free in Singapore: after 15 idle minutes the first request takes about a minute while the service wakes up).

One Docker image runs the API, the worker and the dashboard, and applies migrations on start. [`docs/deploy.md`](docs/deploy.md) walks through Render Free + Neon step by step, including what the free tier means for delivery timing.

## Design

The full design, with every decision and trade-off, is in [`docs/design.md`](docs/design.md): the delivery engine, idempotency, data model, security, operations, and a decisions log. The five choices that shape the engine have short decision records in [`docs/adr/`](docs/adr/README.md): Postgres as the queue, the lease as `next_attempt_at`, the invalid-signature policy, Node 24 with type stripping, and no ordering guarantee.

**Out of scope, on purpose:** teams and roles, billing, multi-region, ordering guarantees, and exactly-once delivery.

## Project layout

```
apps/
  server/src/
    ingest/        receive, verify signatures, de-duplicate, store (outbox)
    delivery/      claim, send (SSRF-safe), classify, schedule, sign, complete, redeliver
    auth/          passwords, sessions, API keys, route guards
    http/          CSRF, limits, hardening, SPA serving
    ops/           retention job, storage guard
    testing/       chaos receiver, fake DNS, test helpers
  web/src/         React dashboard: endpoints, events, attempt timeline, redeliver
docs/              design.md, deploy.md
load/              k6 ingest load test
```
