// Event detail page — YOURS to build (feature 3). The data layer is ready in ../events.ts;
// this file is a starter: it loads the event and shows the raw JSON so the route works today.
// Replace the <pre> with the real page, piece by piece. `npm run dev` + `npm run dev:web`,
// then open an event from the list.
//
// Data you have (see ../types.ts):
//   const event = useEvent(eventId)        → event.data: EventDetail (auto-polls while a
//                                            delivery is pending/in_flight, stops after)
//   const retry = useRetryDelivery(eventId) → retry.mutate(deliveryId)   (dead deliveries only)
//   const replay = useReplayEvent(eventId)  → replay.mutate()            (all enabled destinations)
//   rawBodyUrl(eventId)                     → link to download the exact bytes
//   isActive(delivery)                      → pending or in_flight
//   <SignatureBadge status=… /> from ./Events.tsx, Badge/Button/Card/CopyButton/ErrorText from
//   ../components/ui.tsx, formatBytes/timeAgo from ../lib/format.ts
//
// What the page must show (design F10, Day 10 task 2):
//   1. Header: method, received time, size, content type, source IP, dedupe key and duplicate
//      count (if any). A link back to the endpoint's event list (event.endpointId).
//   2. Signature: if signatureStatus === 'invalid', a prominent "Signature invalid — not
//      forwarded" banner with signatureFailureReason. Never show an expected signature (the
//      API doesn't return one — keep it that way). No replay button for invalid events.
//   3. Headers: a table of event.headers (values can be string or string[]).
//   4. Body: if body.encoding === 'utf8', show the text (pretty-print when it parses as JSON);
//      if 'base64', say it's binary and offer the download. If bodyTruncated, say only the first
//      64 KB were kept. Render text as text — never with dangerouslySetInnerHTML (it's
//      attacker-controlled input).
//   5. Deliveries: one card per delivery — destinationUrl, status badge (pending / in_flight /
//      succeeded / dead + deadReason), attemptCount/maxAttempts, nextAttemptAt while pending,
//      'manual' trigger marker. A "Retry" button on dead deliveries.
//   6. Attempt timeline per delivery: for each attempt — #attemptNo, startedAt, durationMs,
//      statusCode or errorCode + errorMessage, and the responseBodySnippet (collapsed).
//   7. "Replay to all destinations" button (hidden for invalid signatures). Handle the 409
//      (already pending) as information, not an error: ApiError.status === 409.
//
// Hints:
//   - Retry/replay invalidate the event query, so the new delivery appears by itself.
//   - Disable a button while its mutation isPending (double clicks are harmless server-side —
//     the API is idempotent — but the UI shouldn't invite them).
//   - Keep components small: EventHeader, SignatureBanner, HeadersTable, BodyView,
//     DeliveryCard, AttemptTimeline.
import { Link, useParams } from 'react-router';
import { ErrorText, Spinner } from '../components/ui.tsx';
import { useEvent } from '../events.ts';

export function EventDetailPage() {
  const { eventId = '' } = useParams();
  const event = useEvent(eventId);

  if (event.isPending) return <Spinner />;
  if (event.isError) return <ErrorText error={event.error} />;

  const e = event.data;
  return (
    <div className="space-y-4">
      <Link
        to={`/endpoints/${e.endpointId}/events`}
        className="text-sm text-slate-500 hover:underline"
      >
        ← Events
      </Link>
      <h1 className="text-2xl font-semibold">
        {e.method} event <span className="font-mono text-base text-slate-500">{e.id}</span>
      </h1>
      {/* TODO(you): replace this with sections 1–7 above. */}
      <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 text-xs">
        {JSON.stringify(e, null, 2)}
      </pre>
    </div>
  );
}
