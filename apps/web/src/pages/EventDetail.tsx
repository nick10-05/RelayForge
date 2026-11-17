// Event detail: what arrived, whether and where it was forwarded, every attempt, and the
// redeliver controls (design F10).
//
// Security: event headers/body and receiver replies are attacker-controlled. They are rendered
// as React text only (never dangerouslySetInnerHTML; the JSON colouring below splits text into
// <span> text nodes), credential headers are masked by default, the raw body is a download
// (never rendered), no expected signature is ever shown (the API doesn't return one), and
// invalid-signature events get no replay control.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../api.ts';
import {
  Badge,
  Button,
  CopyButton,
  ErrorText,
  PageHeader,
  Spinner,
  buttonClass,
  errorMessage,
} from '../components/ui.tsx';
import type { BadgeTone } from '../components/ui.tsx';
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
import type { Tone } from '../lib/event-view.ts';
import { formatBytes, formatDuration, timeAgo, timeUntil } from '../lib/format.ts';
import type { Delivery, DeliveryAttempt, EventDetail } from '../types.ts';
import { BackLink } from './EndpointDetail.tsx';
import { SignatureBadge } from './Events.tsx';

const TONE: Record<Tone, BadgeTone> = {
  slate: 'slate',
  green: 'green',
  amber: 'amber',
  red: 'red',
};
const DOT: Record<Tone, string> = {
  slate: 'bg-ink-500',
  green: 'bg-mint-400 shadow-[0_0_10px_rgb(79_227_161/0.7)]',
  amber: 'bg-amber-400 shadow-[0_0_10px_rgb(246_185_74/0.6)]',
  red: 'bg-rose-400 shadow-[0_0_10px_rgb(255_95_126/0.6)]',
};

export function EventDetailPage() {
  const { eventId = '' } = useParams();
  const event = useEvent(eventId);

  // isPending = no data yet (first load). Background refreshes (isFetching) keep showing the
  // current data, so the page doesn't flicker every poll.
  if (event.isPending) return <Spinner />;
  if (event.isError) {
    return (
      <div className="space-y-3">
        <ErrorText error={event.error} />
        <BackLink to="/endpoints">Back to endpoints</BackLink>
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
      <div className="grid gap-6 xl:grid-cols-[1.25fr_1fr]">
        <BodyView event={event} />
        <HeadersTable headers={event.headers} />
      </div>
    </div>
  );
}

// 1. Header ----------------------------------------------------------------------------------

function EventHeader({ event, refreshing }: { event: EventDetail; refreshing: boolean }) {
  return (
    <div className="space-y-5">
      <PageHeader
        back={<BackLink to={`/endpoints/${event.endpointId}/events`}>Events</BackLink>}
        eyebrow={
          <span className="flex items-center gap-2">
            Event {refreshing && <span className="text-ember-400 normal-case">· refreshing</span>}
          </span>
        }
        title={
          <>
            <span className="rounded-md border border-ice-400/30 bg-ice-400/10 px-2 py-0.5 font-mono text-sm text-ice-300">
              {event.method}
            </span>
            <span className="font-mono text-xl" title="Path after the ingest URL">
              {event.path.replace(/^\/in\/[^/]+/, '') || '/'}
            </span>
            <SignatureBadge status={event.signatureStatus} />
          </>
        }
        actions={<CopyButton text={event.id} label="Copy event id" />}
      />
      <dl className="panel grid grid-cols-2 gap-px overflow-hidden bg-ink-700/60 p-0 sm:grid-cols-4">
        <Detail label="Received">
          <span title={event.receivedAt}>{timeAgo(event.receivedAt)}</span>
        </Detail>
        <Detail label="Size">{formatBytes(event.sizeBytes)}</Detail>
        <Detail label="Content type">{event.contentType ?? '—'}</Detail>
        <Detail label="Source IP">{event.sourceIp ?? '—'}</Detail>
        <Detail label="Event id">{event.id}</Detail>
        {event.query && <Detail label="Query">{event.query}</Detail>}
        {event.dedupeKey && <Detail label="Dedupe key">{event.dedupeKey}</Detail>}
        {event.duplicateCount > 0 && (
          <Detail label="Duplicates">
            {event.duplicateCount} absorbed
            {event.lastDuplicateAt && (
              <span className="text-dim" title={event.lastDuplicateAt}>
                {' '}
                · last {timeAgo(event.lastDuplicateAt)}
              </span>
            )}
          </Detail>
        )}
      </dl>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-ink-850 px-4 py-3">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 truncate font-mono text-[13px]">{children}</dd>
    </div>
  );
}

// 2. Signature -------------------------------------------------------------------------------

function SignatureBanner({ reason }: { reason: string | null }) {
  // Only the reason category is shown — never an expected signature (that would hand an
  // attacker a signing oracle). The API doesn't return one; keep it that way.
  return (
    <div
      role="alert"
      className="flex gap-4 rounded-xl border border-rose-400/30 bg-rose-500/[0.07] p-4"
    >
      <span className="mt-1 size-2.5 shrink-0 rounded-full bg-rose-400 shadow-[0_0_12px_rgb(255_95_126/0.8)]" />
      <div>
        <p className="font-medium text-rose-200">Signature invalid · not forwarded</p>
        <p className="mt-0.5 text-sm text-rose-300/90">{signatureReasonText(reason)}</p>
        <p className="mt-1.5 text-xs text-muted">
          Stored for inspection only (first 64 KB, kept 24 hours). It can never be forwarded or
          replayed.
        </p>
      </div>
    </div>
  );
}

// 3. Deliveries, attempt trace, replay --------------------------------------------------------

function Deliveries({ event }: { event: EventDetail }) {
  const invalid = event.signatureStatus === 'invalid';
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Deliveries</h2>
          <p className="text-sm text-muted">
            One per destination, with every attempt the engine made.
          </p>
        </div>
        {!invalid && <ReplayButton eventId={event.id} />}
      </div>
      {event.deliveries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-700 p-5 text-sm text-muted">
          {noDeliveriesText(event)}
        </p>
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
          if (window.confirm('Send this event again to every enabled destination?'))
            replay.mutate(undefined);
        }}
      >
        <span aria-hidden="true" className="text-ember-400">
          ↻
        </span>
        {replay.isPending ? 'Replaying…' : 'Replay to all destinations'}
      </Button>
      {replay.isSuccess && (
        <p className="text-xs text-mint-300">
          Queued {created} new {created === 1 ? 'delivery' : 'deliveries'}.
        </p>
      )}
      {replay.isError &&
        (alreadyPending(replay.error) ? (
          <p className="text-xs text-muted">Already pending for every destination.</p>
        ) : (
          <p role="alert" className="text-xs text-rose-300">
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
    <li className="panel overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`size-2.5 shrink-0 rounded-full ${DOT[status.tone]} ${d.status === 'in_flight' ? 'animate-pulse' : ''}`}
            />
            <p className="truncate font-mono text-[13px]" title={d.destinationUrl}>
              {d.destinationUrl}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-5.5 text-xs text-muted">
            <Badge tone={TONE[status.tone]}>{status.label}</Badge>
            {d.trigger === 'manual' && <Badge tone="ember">manual redelivery</Badge>}
            <span className="font-mono">
              attempt {d.attemptCount}/{d.maxAttempts}
            </span>
            <DeliveryTiming delivery={d} />
          </div>
          {status.detail && <p className="pl-5.5 text-xs text-rose-300">Dead: {status.detail}.</p>}
        </div>
        {d.status === 'dead' && (
          <div className="flex flex-col items-end gap-1">
            <Button
              variant="secondary"
              disabled={retry.isPending}
              onClick={() => retry.mutate(d.id)}
            >
              {retry.isPending ? 'Retrying…' : 'Retry delivery'}
            </Button>
            {retry.isError &&
              (alreadyPending(retry.error) ? (
                <p className="text-xs text-muted">A retry is already pending.</p>
              ) : (
                <p role="alert" className="text-xs text-rose-300">
                  {errorMessage(retry.error)}
                </p>
              ))}
          </div>
        )}
      </div>
      <Trace delivery={d} />
      <AttemptList attempts={d.attempts} />
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
  if (d.status === 'in_flight') return <span className="text-ice-300">sending now…</span>;
  return d.completedAt ? (
    <span title={d.completedAt}>finished {timeAgo(d.completedAt)}</span>
  ) : null;
}

/** Attempts as a signal trace: one node per attempt, then where the delivery stands now. */
function Trace({ delivery: d }: { delivery: Delivery }) {
  const end =
    d.status === 'succeeded'
      ? { label: 'delivered', cls: 'border-mint-400/50 text-mint-300' }
      : d.status === 'dead'
        ? { label: 'dead letter', cls: 'border-rose-400/50 text-rose-300' }
        : d.status === 'in_flight'
          ? { label: 'sending', cls: 'border-ice-400/50 text-ice-300' }
          : {
              label: `retry ${timeUntil(d.nextAttemptAt)}`,
              cls: 'border-amber-400/40 text-amber-300',
            };
  return (
    <div className="overflow-x-auto border-y border-ink-700/60 bg-ink-900/60 px-5 py-4">
      <ol className="flex min-w-max items-center">
        <li className="flex items-center">
          <span className="rounded-md border border-ink-600 px-2 py-0.5 font-mono text-[10.5px] text-dim">
            queued
          </span>
        </li>
        {d.attempts.map((a) => {
          const o = attemptOutcome(a);
          return (
            <li key={a.attemptNo} className="flex items-center">
              <span className="h-px w-8 bg-ink-600" />
              <span
                className="flex items-center gap-1.5 rounded-md border border-ink-600 bg-ink-850 px-2 py-0.5 font-mono text-[10.5px]"
                title={`${a.startedAt} · ${formatDuration(a.durationMs)}`}
              >
                <span
                  className={`size-1.5 rounded-full ${o.tone === 'green' ? 'bg-mint-400' : 'bg-rose-400'}`}
                />
                <span className="text-dim">#{a.attemptNo}</span>
                <span className={o.tone === 'green' ? 'text-mint-300' : 'text-rose-300'}>
                  {o.label}
                </span>
              </span>
            </li>
          );
        })}
        <li className="flex items-center">
          <span
            className={`h-px w-8 ${d.status === 'succeeded' ? 'bg-mint-400/50' : d.status === 'dead' ? 'bg-rose-400/50' : 'border-t border-dashed border-ink-500 bg-transparent'}`}
          />
          <span className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] ${end.cls}`}>
            {end.label}
          </span>
        </li>
      </ol>
    </div>
  );
}

function AttemptList({ attempts }: { attempts: DeliveryAttempt[] }) {
  if (attempts.length === 0) return <p className="px-5 py-3 text-xs text-dim">No attempts yet.</p>;
  return (
    <ol className="divide-y divide-ink-700/50">
      {[...attempts].reverse().map((a) => (
        <AttemptRow key={a.attemptNo} attempt={a} />
      ))}
    </ol>
  );
}

function AttemptRow({ attempt: a }: { attempt: DeliveryAttempt }) {
  const outcome = attemptOutcome(a);
  const hasResponse = a.responseBodySnippet !== null || a.responseHeaders !== null;
  return (
    <li className="space-y-1.5 px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-6 font-mono text-xs text-dim">#{a.attemptNo}</span>
        <Badge tone={TONE[outcome.tone]}>{outcome.label}</Badge>
        <span className="font-mono text-xs text-muted">{formatDuration(a.durationMs)}</span>
        <span className="ml-auto text-xs text-dim" title={a.startedAt}>
          {timeAgo(a.startedAt)}
        </span>
      </div>
      {a.errorMessage && <p className="pl-9 font-mono text-xs text-rose-300">{a.errorMessage}</p>}
      {hasResponse && (
        <details className="group pl-9 text-xs">
          <summary className="cursor-pointer text-muted transition-colors select-none hover:text-fg">
            Receiver response
          </summary>
          {a.responseHeaders && (
            <pre className="mt-2 overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-muted">
              {headerRows(a.responseHeaders)
                .map((h) => `${h.name}: ${h.value}`)
                .join('\n')}
            </pre>
          )}
          {a.responseBodySnippet !== null && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 whitespace-pre-wrap">
              {a.responseBodySnippet || '(empty body)'}
            </pre>
          )}
        </details>
      )}
    </li>
  );
}

// 4. Body ------------------------------------------------------------------------------------

/** Colours JSON by splitting it into text <span>s (still plain text nodes — nothing is parsed as HTML). */
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const COLOUR_LIMIT = 60_000;

function JsonText({ text }: { text: string }) {
  if (text.length > COLOUR_LIMIT) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const i = m.index;
    if (i > last) out.push(text.slice(last, i));
    if (m[1] !== undefined) {
      out.push(
        <span key={i} className={m[2] ? 'text-ice-300' : 'text-mint-300'}>
          {m[1]}
        </span>,
      );
      if (m[2])
        out.push(
          <span key={`${i}c`} className="text-dim">
            {m[2]}
          </span>,
        );
    } else if (m[3] !== undefined) {
      out.push(
        <span key={i} className="text-ember-300">
          {m[3]}
        </span>,
      );
    } else {
      out.push(
        <span key={i} className="text-amber-300">
          {m[4]}
        </span>,
      );
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function BodyView({ event }: { event: EventDetail }) {
  const view = viewBody(event.body);
  const kind = { empty: 'empty', json: 'JSON', text: 'text', binary: 'binary' }[view.kind];
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          Body <Badge>{kind}</Badge>
        </h2>
        {/* A download (octet-stream + attachment), never rendered: it may be HTML or a script. */}
        <a href={rawBodyUrl(event.id)} download className={buttonClass('secondary')}>
          Download raw bytes
        </a>
      </div>
      {event.bodyTruncated && (
        <p className="text-sm text-amber-300">
          Only the first 64 KB of this {formatBytes(event.sizeBytes)} body were kept
          (invalid-signature events are stored truncated).
        </p>
      )}
      <div className="panel overflow-hidden bg-ink-950 p-0">
        {view.kind === 'empty' && <p className="p-5 text-sm text-dim">Empty body.</p>}
        {(view.kind === 'json' || view.kind === 'text') && (
          <>
            {/* Text nodes in a <pre>: React escapes them, so markup in the body stays inert. */}
            <pre className="max-h-[32rem] overflow-auto p-5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg/90">
              {view.kind === 'json' ? <JsonText text={view.text} /> : view.text}
            </pre>
            {view.cut && (
              <p className="border-t border-ink-700 px-5 py-2 text-xs text-dim">
                Display cut for length. Download the raw bytes for the full body.
              </p>
            )}
          </>
        )}
        {view.kind === 'binary' && (
          <div className="space-y-2 p-5">
            <p className="text-sm text-muted">
              Binary body (not valid UTF-8). First {view.previewBytes} bytes:
            </p>
            <pre className="overflow-x-auto font-mono text-xs text-muted">{view.hex}</pre>
          </div>
        )}
      </div>
    </section>
  );
}

// 5. Headers ---------------------------------------------------------------------------------

function HeadersTable({ headers }: { headers: EventDetail['headers'] }) {
  const rows = headerRows(headers);
  return (
    <section className="min-w-0 space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        Request headers <Badge>{rows.length}</Badge>
      </h2>
      <div className="panel max-h-[34rem] overflow-auto p-0">
        <table className="w-full text-left text-xs">
          <tbody className="divide-y divide-ink-700/50">
            {rows.map((h, i) => (
              <tr key={`${h.name}-${i}`} className="hover:bg-ink-800/50">
                <th
                  scope="row"
                  className="w-2/5 px-4 py-2 align-top font-mono font-normal text-ice-300"
                >
                  {h.name}
                </th>
                <td className="px-4 py-2 font-mono break-all text-fg/85">
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
      <span className={shown ? '' : 'text-dim'}>{shown ? value : MASK}</span>
      <button
        type="button"
        className="text-ember-300 hover:text-ember-200"
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'hide' : 'reveal'}
      </button>
    </span>
  );
}
