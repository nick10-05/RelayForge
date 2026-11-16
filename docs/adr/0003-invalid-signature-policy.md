# ADR 0003: Invalid-signature events are stored, never forwarded

- **Status:** Accepted (14 Nov 2026)
- **Related:** design §5.1, §7.2, §8.3; engine invariant 8

## Context

An endpoint can verify inbound signatures (generic HMAC or Standard Webhooks). When a request fails
verification there are two opposite needs:

- **Debugging.** The most common cause is a misconfiguration (wrong secret, wrong header, a proxy
  that re-encoded the body). The developer needs to *see* the failed request to fix it.
- **Safety.** A forged request must never reach a destination, and an attacker must not be able to
  use the endpoint to fill our storage, burn the endpoint's rate budget, or learn anything about the
  expected signature.

Rejecting without storing helps safety but leaves developers blind. Storing like a normal event
helps debugging but turns forged traffic into deliveries and unbounded storage.

## Decision

Store for inspection, **never forward**, and keep it bounded:

| Control | Rule |
|---|---|
| Response | `401`, same body whatever the failure reason (the reason is for the owner, not the sender) |
| Forwarding | No delivery rows are created; replay and retry are refused (`422`) |
| Stored | `signature_status = 'invalid'`, the failure reason (`missing_header`, `malformed`, `mismatch`, `timestamp_out_of_tolerance`), headers, size, source IP |
| Body | First **64 KB** only (`body_truncated = true` if cut) |
| Rate limit | A separate, stricter bucket per endpoint (default 10/min). Over it → still `401`, **not stored**, only counted |
| Retention | **24 h** (valid events: 7 days) |
| Dedupe | Never entered into the dedupe index |
| Dashboard | An "invalid" signature badge, the reason, and a "Not forwarded" note; the expected signature is **never** shown |

If the verify secret can't be opened (missing key, corrupt row), the response is `503` and nothing
is stored: the provider retries once it's fixed, instead of a real event being filed as forged.

## Consequences

**Good**
- Developers can debug a broken integration from the dashboard instead of guessing.
- Forged traffic can't produce outbound requests. Invariant 8 is tested: an invalid event never
  creates a delivery or an HTTP call, including through replay.
- Storage cost of an attack is capped: ≤ 10 events/min/endpoint × 64 KB × 24 h.
- An attacker can't "reserve" a real event's dedupe key by sending a forgery first, which would make
  the genuine event look like a duplicate and get dropped.
- No signature oracle: the same `401` for every reason and the expected value is never revealed.

**Bad / accepted**
- Some forged requests are stored for a day, so the owner sees attacker-controlled content (shown as
  inert text; the raw body downloads as `application/octet-stream`, never rendered).
- Past the stricter limit, failed requests are only counted, so a misconfiguration under heavy
  traffic shows a sample, not every request.
- Two retention rules and two rate limits to explain and test.

## Alternatives considered

| Option | Why not |
|---|---|
| Reject and store nothing | Developers can't see why verification fails; the commonest support problem stays invisible |
| Store as a normal event, flag it, forward anyway | Forwarding forged content defeats the point of verifying |
| Store everything, full body, normal retention | An attacker can fill the free database |
| Return the failure reason to the sender | Helps an attacker probe the configuration |

## Interview version

"A failed signature gets a 401 and is kept for 24 hours so the owner can debug it — truncated to
64 KB and behind its own stricter rate limit. It never creates a delivery and can't be replayed;
there's a test for exactly that. It's also kept out of the dedupe index so a forgery can't shadow a
real event."
