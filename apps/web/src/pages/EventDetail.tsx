// Event detail: what arrived, whether and where it was forwarded, every attempt, and the
// redeliver controls (design F10).
//
// Security: event headers/body and receiver replies are attacker-controlled. They are rendered
// as React text only (never dangerouslySetInnerHTML), credential headers are masked by default,
// the raw body is a download (never rendered), no expected signature is ever shown (the API
// doesn't return one), and invalid-signature events get no replay control.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api.ts';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorText,
  Spinner,
  errorMessage,
} from '../components/ui.tsx';
import { rawBodyUrl, useEvent, useReplayEvent, useRetryDelivery } from '../events.ts';
import {
  MASK,
  attemptOutcome,
  deliveryStatusView,
  headerRows,
  noDeliveriesText,
  signatureReasonText,
  viewBody,
} from '../lib/event-view.ts';
import { formatBytes, formatDuration, timeAgo, timeUntil } from '../lib/format.ts';
import type { Delivery, DeliveryAttempt, EventDetail } from '../types.ts';
import { SignatureBadge } from './Events.tsx';

export function EventDetailPage() {
  const { eventId = '' } = useParams();
  const event = useEvent(eventId);

  // isPending = no data yet (first load). Background refreshes (isFetching) keep showing the
  // current data, so the page doesn't flicker every poll.
  if (event.isPending) return <Spinner />;
  if (event.isError) {
    return (
      <div className="space-y-2">
        <ErrorText error={event.error} />
        <Link to="/endpoints" className="text-sm text-indigo-700 underline">
          Back to endpoints
        </Link>
      </div>
    );
  }
  return <EventView event={event.data} refreshing={event.isFetching} />;
}

function EventView({ event, refreshing }: { event: EventDetail; refreshing: boolean }) {
  const invalid = event.signatureStatus === 'invalid';
  return (
    <div className="space-y-6">
      <EventHeader event={event} refreshing={refreshing} />
      {invalid && <SignatureBanner reason={event.signatureFailureReason} />}
      <Deliveries event={event} />
      <BodyView event={event} />
      <HeadersTable headers={event.headers} />
    </div>
  );
}

// 1. Header ----------------------------------------------------------------------------------

function EventHeader({ event, refreshing }: { event: EventDetail; refreshing: boolean }) {
  return (
    <div className="space-y-3">
      <Link
        to={`/endpoints/${event.endpointId}/events`}
        className="text-sm text-slate-500 hover:underline"
      >
        ← Events
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-sm text-white">
            {event.method}
          </span>
          Event
        </h1>
        <SignatureBadge status={event.signatureStatus} />
        {refreshing && <span className="text-xs text-slate-400">refreshing…</span>}
      </div>
      <div className="flex items-center gap-2">
        <code className="truncate font-mono text-xs text-slate-500">{event.id}</code>
        <CopyButton text={event.id} label="Copy id" />
      </div>
      <Card>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Detail label="Received">
            <span title={event.receivedAt}>{timeAgo(event.receivedAt)}</span>
          </Detail>
          <Detail label="Size">{formatBytes(event.sizeBytes)}</Detail>
          <Detail label="Content type">{event.contentType ?? '—'}</Detail>
          <Detail label="Source IP">{event.sourceIp ?? '—'}</Detail>
          {event.query && <Detail label="Query">{event.query}</Detail>}
          {event.dedupeKey && <Detail label="Dedupe key">{event.dedupeKey}</Detail>}
          {event.duplicateCount > 0 && (
            <Detail label="Duplicates">
              {event.duplicateCount} (not re-forwarded)
              {event.lastDuplicateAt && (
                <span className="text-slate-500" title={event.lastDuplicateAt}>
                  {' '}
                  · last {timeAgo(event.lastDuplicateAt)}
                </span>
              )}
            </Detail>
          )}
        </dl>
      </Card>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}

// 2. Signature -------------------------------------------------------------------------------

function SignatureBanner({ reason }: { reason: string | null }) {
  // Only the reason category is shown — never an expected signature (that would hand an
  // attacker a signing oracle). The API doesn't return one; keep it that way.
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4">
      <p className="font-medium text-red-900">Signature invalid — not forwarded</p>
      <p className="text-sm text-red-800">{signatureReasonText(reason)}</p>
      <p className="mt-1 text-xs text-red-700">
        Stored for inspection only (first 64 KB, kept 24 hours). It can never be forwarded or
        replayed.
      </p>
    </div>
  );
}

// 5–7. Deliveries, attempt timeline, replay ---------------------------------------------------

function Deliveries({ event }: { event: EventDetail }) {
  const invalid = event.signatureStatus === 'invalid';
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Deliveries</h2>
        {!invalid && <ReplayButton eventId={event.id} />}
      </div>
      {event.deliveries.length === 0 ? (
        <p className="text-sm text-slate-600">{noDeliveriesText(event)}</p>
      ) : (
        <ul className="space-y-3">
          {event.deliveries.map((d) => (
            <DeliveryCard key={d.id} eventId={event.id} delivery={d} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A 409 from retry/replay means "already pending" (e.g. a double click): information. */
const alreadyPending = (error: unknown) => error instanceof ApiError && error.status === 409;

function ReplayButton({ eventId }: { eventId: string }) {
  const replay = useReplayEvent(eventId);
  const created = replay.data?.deliveries.filter((d) => d.created).length ?? 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        disabled={replay.isPending}
        onClick={() => {
          if (window.confirm('Send this event again to every enabled destination?')) {
            replay.mutate(undefined);
          }
        }}
      >
        {replay.isPending ? 'Replaying…' : 'Replay to all destinations'}
      </Button>
      {replay.isSuccess && (
        <p className="text-xs text-emerald-700">
          Queued {created} new {created === 1 ? 'delivery' : 'deliveries'}.
        </p>
      )}
      {replay.isError &&
        (alreadyPending(replay.error) ? (
          <p className="text-xs text-slate-600">Already pending for every destination.</p>
        ) : (
          <p role="alert" className="text-xs text-red-700">
            {errorMessage(replay.error)}
          </p>
        ))}
    </div>
  );
}

function DeliveryCard({ eventId, delivery: d }: { eventId: string; delivery: Delivery }) {
  // One mutation per card, so each Retry button has its own pending/error state.
  const retry = useRetryDelivery(eventId);
  const status = deliveryStatusView(d);

  return (
    <li>
      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="truncate font-mono text-sm" title={d.destinationUrl}>
              {d.destinationUrl}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <Badge tone={status.tone}>{status.label}</Badge>
              {d.trigger === 'manual' && <Badge>manual redelivery</Badge>}
              <span>
                attempt {d.attemptCount} of {d.maxAttempts}
              </span>
              <DeliveryTiming delivery={d} />
            </div>
            {status.detail && <p className="text-xs text-red-700">Dead: {status.detail}.</p>}
          </div>
          {d.status === 'dead' && (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="secondary"
                disabled={retry.isPending}
                onClick={() => retry.mutate(d.id)}
              >
                {retry.isPending ? 'Retrying…' : 'Retry'}
              </Button>
              {retry.isError &&
                (alreadyPending(retry.error) ? (
                  <p className="text-xs text-slate-600">A retry is already pending.</p>
                ) : (
                  <p role="alert" className="text-xs text-red-700">
                    {errorMessage(retry.error)}
                  </p>
                ))}
            </div>
          )}
        </div>
        <AttemptTimeline attempts={d.attempts} />
      </Card>
    </li>
  );
}

function DeliveryTiming({ delivery: d }: { delivery: Delivery }) {
  if (d.status === 'pending') {
    return (
      <span title={d.nextAttemptAt}>
        {d.attemptCount === 0 ? 'first attempt' : 'next attempt'} {timeUntil(d.nextAttemptAt)}
      </span>
    );
  }
  if (d.status === 'in_flight') return <span>sending now…</span>;
  return d.completedAt ? (
    <span title={d.completedAt}>finished {timeAgo(d.completedAt)}</span>
  ) : null;
}

function AttemptTimeline({ attempts }: { attempts: DeliveryAttempt[] }) {
  if (attempts.length === 0) return <p className="text-xs text-slate-500">No attempts yet.</p>;
  return (
    <ol className="space-y-2 border-l-2 border-slate-200 pl-4">
      {attempts.map((a) => (
        <AttemptRow key={a.attemptNo} attempt={a} />
      ))}
    </ol>
  );
}

function AttemptRow({ attempt: a }: { attempt: DeliveryAttempt }) {
  const outcome = attemptOutcome(a);
  const hasResponse = a.responseBodySnippet !== null || a.responseHeaders !== null;
  return (
    <li className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-slate-500">#{a.attemptNo}</span>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
        <span className="text-xs text-slate-600" title={a.startedAt}>
          {timeAgo(a.startedAt)} · {formatDuration(a.durationMs)}
        </span>
      </div>
      {a.errorMessage && <p className="text-xs text-red-700">{a.errorMessage}</p>}
      {hasResponse && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-600">Receiver response</summary>
          {a.responseHeaders && (
            <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2">
              {headerRows(a.responseHeaders)
                .map((h) => `${h.name}: ${h.value}`)
                .join('\n')}
            </pre>
          )}
          {a.responseBodySnippet !== null && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 whitespace-pre-wrap">
              {a.responseBodySnippet || '(empty body)'}
            </pre>
          )}
        </details>
      )}
    </li>
  );
}

// 4. Body ------------------------------------------------------------------------------------

function BodyView({ event }: { event: EventDetail }) {
  const view = viewBody(event.body);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Body</h2>
        {/* A download (octet-stream + attachment), never rendered: it may be HTML or a script. */}
        <a
          href={rawBodyUrl(event.id)}
          download
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
        >
          Download raw bytes
        </a>
      </div>
      {event.bodyTruncated && (
        <p className="text-sm text-amber-800">
          Only the first 64 KB of this {formatBytes(event.sizeBytes)} body were kept
          (invalid-signature events are stored truncated).
        </p>
      )}
      <Card className="p-0">
        {view.kind === 'empty' && <p className="p-4 text-sm text-slate-500">Empty body.</p>}
        {(view.kind === 'json' || view.kind === 'text') && (
          <>
            {/* Text node in a <pre>: React escapes it, so markup in the body stays inert. */}
            <pre className="max-h-[32rem] overflow-auto p-4 font-mono text-xs whitespace-pre-wrap">
              {view.text}
            </pre>
            {view.cut && (
              <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
                Display cut for length — download the raw bytes for the full body.
              </p>
            )}
          </>
        )}
        {view.kind === 'binary' && (
          <div className="space-y-2 p-4">
            <p className="text-sm text-slate-600">
              Binary body (not valid UTF-8). First {view.previewBytes} bytes:
            </p>
            <pre className="overflow-x-auto font-mono text-xs">{view.hex}</pre>
          </div>
        )}
      </Card>
    </section>
  );
}

// 3. Headers ---------------------------------------------------------------------------------

function HeadersTable({ headers }: { headers: EventDetail['headers'] }) {
  const rows = headerRows(headers);
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Request headers</h2>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-left text-xs">
          <tbody className="divide-y divide-slate-100">
            {rows.map((h, i) => (
              <tr key={`${h.name}-${i}`}>
                <th scope="row" className="w-1/3 px-3 py-1.5 align-top font-mono font-medium">
                  {h.name}
                </th>
                <td className="px-3 py-1.5 font-mono break-all">
                  {h.sensitive ? <MaskedValue value={h.value} /> : h.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MaskedValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <span>{shown ? value : MASK}</span>
      <button
        type="button"
        className="text-indigo-700 underline"
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'hide' : 'reveal'}
      </button>
    </span>
  );
}
