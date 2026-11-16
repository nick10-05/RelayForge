# Architecture decision records

Short records of the decisions that shape RelayForge: the context, what was chosen, what it costs,
and what was rejected. The full design is in [`../design.md`](../design.md).

| # | Decision | Status |
|---|---|---|
| [0001](0001-postgres-as-the-queue.md) | Postgres is the queue (`SKIP LOCKED`, transactional outbox) | Accepted |
| [0002](0002-lease-stored-as-next-attempt-at.md) | The lease is stored as `next_attempt_at`; fenced completion | Accepted |
| [0003](0003-invalid-signature-policy.md) | Invalid-signature events are stored, never forwarded | Accepted |
| [0004](0004-node-24-with-type-stripping.md) | Node.js 24 LTS running TypeScript by type stripping | Accepted |
| [0005](0005-no-ordering-guarantee.md) | No ordering guarantee; at-least-once delivery | Accepted |

Format: Context → Decision → Consequences (good and accepted costs) → Alternatives → a two-sentence
interview version. A changed decision gets a new record that supersedes the old one; old records
aren't rewritten.
