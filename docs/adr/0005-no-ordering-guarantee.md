# ADR 0005: No ordering guarantee; at-least-once delivery

- **Status:** Accepted (14 Nov 2026)
- **Related:** design §3, §4.5, §4.7, §5.2; ADR 0002

## Context

Receivers sometimes assume events arrive in the order they happened (`created` before `updated`).
Offering that guarantee would mean that, per destination, event *n+1* can't be sent until event *n*
has succeeded or died.

That conflicts with everything else the engine does:

- **Retries with backoff.** One failing event would block every later event for that destination
  for up to ~3 hours (10 attempts, 1 h cap).
- **Concurrency.** The dispatcher sends up to 8 requests at once; two events for one destination can
  be in flight together and finish in either order.
- **Fan-out and replay.** Each destination progresses independently; a manual replay re-sends an
  old event after newer ones.
- **Crash recovery.** A lease expiry re-sends a delivery after later ones may have succeeded.

Exactly-once is also impossible over HTTP: if the receiver processes a request and the response is
lost, we can't know, and must retry.

## Decision

- **No ordering guarantee**, stated in the README. Due rows are claimed oldest-due-first
  (`ORDER BY next_attempt_at`), which gives roughly arrival order when nothing fails, but nothing
  depends on it.
- **At-least-once delivery.** Every attempt, retry, fan-out copy and replay carries the same
  `X-RelayForge-Id` (the event id). Receivers dedupe on it. Manual redeliveries also send
  `X-RelayForge-Replay: true`.
- Each request carries `X-RelayForge-Timestamp` (signed), so a receiver that cares about order can
  compare timestamps or, better, fetch the current state of the resource.

## Consequences

**Good**
- A failing event never blocks others (no head-of-line blocking); one bad payload affects only itself.
- Delivery is parallel across and within destinations, which is where the throughput comes from.
- Matches the contract of the providers our users already integrate with (Stripe and GitHub
  both deliver out of order and at least once), so receivers already handle it.

**Bad / accepted**
- Receivers must be idempotent and order-tolerant. The README states the contract plainly.
- Load testing showed it in practice: after the server was killed mid-run, every event was delivered
  and one request reached the receiver twice (no duplicate delivery *rows*; a duplicate *send*).

## Alternatives considered

| Option | Why not |
|---|---|
| Strict per-destination FIFO | Head-of-line blocking for hours on one failure; serialises each destination |
| FIFO per ordering key (e.g. per customer) | Needs a key from the payload, per-key locking in the claim query, and still blocks that key; a "later" feature at best |
| Exactly-once | Not achievable over HTTP without the receiver's cooperation; dedupe on `X-RelayForge-Id` *is* that cooperation |

## Interview version

"We guarantee at-least-once, not ordering — same as Stripe and GitHub. Ordering would mean one
failing event blocks everything behind it for hours. Instead every copy of an event carries the
same id so the receiver can dedupe, and a signed timestamp if it needs to reason about order."
