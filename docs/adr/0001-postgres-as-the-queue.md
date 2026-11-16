# ADR 0001: Postgres is the queue

- **Status:** Accepted (14 Nov 2026)
- **Related:** design §3, §4.2, §4.3, §4.6

## Context

Every stored webhook has to be forwarded to one or more destinations, with retries over hours. That
needs a durable work queue. The usual answer is a broker (Redis/BullMQ, RabbitMQ, SQS) next to the
database.

Two facts shape the choice here:

1. **The enqueue must be atomic with the write.** If the event is committed but the job isn't (or
   the reverse), an event is silently never delivered, or a job points at nothing. With a separate
   broker that needs a transactional outbox *plus* a relay process to move rows into the broker.
2. **The budget is ₹0.** Render Free gives one small instance; Neon's free Postgres scales to zero
   when idle. A second always-on service would cost money or keep things awake.

## Decision

The `deliveries` table **is** the queue. Ingest inserts the event and one `pending` delivery row
per enabled destination in **one transaction**, and responds `202` only after commit.

Workers claim due rows with a single statement:

```sql
SELECT ... WHERE status IN ('pending','in_flight') AND next_attempt_at <= now()
ORDER BY next_attempt_at LIMIT $batch
FOR UPDATE OF d SKIP LOCKED
```

`SKIP LOCKED` lets concurrent claimers take disjoint rows without waiting on each other. The worker
sleeps until an in-process wake-up (new event, redelivery, resume) or the earliest
`next_attempt_at`, so an idle system sends no queries and the database can scale to zero.

## Consequences

**Good**
- The outbox is the queue: "event stored" and "delivery scheduled" can't disagree. One commit, no relay.
- One stateful system to run, back up and reason about. Every delivery's state is a SQL query away,
  which is what the dashboard shows.
- Queue state survives restarts and crashes for free (it's in Postgres).

**Bad / accepted**
- Throughput ceiling. Local k6 baseline (one Node process, Docker Postgres): ≈ 665 req/s
  ingest-only, ≈ 570 req/s with delivery, worker drain ≈ 260/s at concurrency 8. Far above what this
  project needs, far below Kafka.
- Every claim and completion is a write, which adds to WAL and vacuum load as volume grows.
- Rows are polled by due time, not pushed; latency depends on the wake-up signal working
  (it's in-process, so a second instance would need `LISTEN/NOTIFY` or a short poll).

## Alternatives considered

| Option | Why not |
|---|---|
| Redis + BullMQ | Second stateful service; enqueue not atomic with the event insert; free Redis tiers are small and volatile |
| RabbitMQ / SQS | Same atomicity problem; SQS needs a card; more infrastructure to explain than the problem needs |
| Outbox table + relay into a broker | Correct, but two queues and a relay process for no gain at this scale |
| pg-boss / Graphile Worker | Same idea packaged; writing the claim query by hand is the point of the project and keeps lease/fencing semantics explicit |

**Scale path:** partition `deliveries` by status/time, run several workers (already safe with
`SKIP LOCKED`), and only past that move dispatch to Kafka/SQS fed by the same outbox.

## Interview version

"The queue is a Postgres table, so enqueueing is part of the same transaction that stores the
event: they can't disagree. `FOR UPDATE SKIP LOCKED` gives me safe concurrent claiming. It tops out
in the hundreds of deliveries per second on one box, which I measured, and the scale path is
documented."
