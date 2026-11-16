# ADR 0002: The lease is stored as `next_attempt_at`

- **Status:** Accepted (14 Nov 2026)
- **Related:** design §4.1, §4.3, §4.4, §4.10; ADR 0001

## Context

A worker claims a delivery, makes an HTTP call (up to 15 s), then records the result. The worker can
crash, be killed by a deploy, or stall at any point in between. Two things must hold:

1. A delivery whose worker died is **retried**, not stuck `in_flight` forever.
2. A worker that was merely slow must **not overwrite** the result of whoever retried after it.

Holding a row lock or an open transaction for the duration of the HTTP call would solve (1) by
making the database release it on disconnect, but it ties up a connection per request (Neon's free
tier has few) and keeps transactions open for seconds.

## Decision

Claiming sets a **lease** without a separate column or sweeper:

```sql
UPDATE deliveries SET status = 'in_flight',
       attempt_count   = attempt_count + 1,
       lease_owner     = $workerId,
       next_attempt_at = now() + 60 s     -- the lease IS next_attempt_at
```

- The claim query already selects `status IN ('pending','in_flight') AND next_attempt_at <= now()`.
  So an `in_flight` row whose lease ran out is simply **due again**: it's re-claimed like any other
  row. No sweeper job.
- **Lease (60 s) > the longest possible request (15 s)**, so a healthy worker always finishes first.
- **Attempts are counted at claim time.** A payload that crashes the worker still uses up attempts.
  A row whose lease expires on its last allowed attempt is finished as `dead/exhausted` by a cheap
  reaper query in the worker loop, so it can't loop forever.
- **Fenced completion.** The result is written with
  `WHERE id = $id AND lease_owner = $me AND attempt_count = $claimedAttempt`. If someone else
  re-claimed the row, 0 rows match and the stale result is discarded (its attempt is still logged).
- All times come from the database clock (`now()`), so workers' clocks can't disagree.
- The claim is one auto-committed statement: **no lock is held during the HTTP call.**

## Consequences

**Good**
- Crash recovery is a property of the query, not an extra process that could itself fail.
- One timestamp column drives retries, backoff and lease expiry; the scheduler only needs
  `min(next_attempt_at)` to know when to wake.
- Poison payloads end `dead`; stale workers can't clobber newer results. Both are tested
  (invariants 3, 4, 5 and 6) with real concurrent claimers.

**Bad / accepted**
- After a crash, a delivery waits up to the lease (60 s) before it is retried.
- A worker that is slower than the lease (shouldn't happen: 15 s cap vs 60 s) can cause a
  **duplicate send**: the receiver gets the request twice. This is within the at-least-once contract
  (receivers dedupe on `X-RelayForge-Id`), and fencing keeps the *record* correct.
- `next_attempt_at` means two things depending on `status`. That is documented in the claim code
  and the schema, but it's a subtlety a new reader must learn.

## Alternatives considered

| Option | Why not |
|---|---|
| Hold `FOR UPDATE` / an open transaction during the HTTP call | One pooled connection per in-flight request; long transactions; a hung destination pins a connection |
| Separate `lease_expires_at` column + sweeper job | Same behaviour with more moving parts; the sweeper is another thing that must run |
| Postgres advisory locks | Session-scoped: lost with the connection, and still need a connection held per request |
| Heartbeats from the worker | Extra writes every few seconds per request; overkill with a 15 s request cap |

## Interview version

"The lease is just `next_attempt_at` pushed 60 seconds into the future. If the worker dies, the row
becomes due again and gets re-claimed — there's no sweeper. Attempts are counted at claim time so a
crashing payload still runs out, and completion is fenced on worker id plus attempt number so a slow
worker can't overwrite a newer result."
