// The signed-in home: real numbers from GET /api/v1/stats (polled), a live activity feed merged
// from each endpoint's newest events, and the relay graph that fires a packet per new event.
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { get } from '../api.ts';
import { Ring, SegmentBar, Sparkline, TrafficChart } from '../components/charts.tsx';
import type { ChartColor } from '../components/charts.tsx';
import { Topology } from '../components/Topology.tsx';
import type { Arrival } from '../components/Topology.tsx';
import { Badge, ErrorText, LiveDot, PageHeader, Spinner, buttonClass } from '../components/ui.tsx';
import { LIST_POLL_MS } from '../events.ts';
import { formatBytes, timeAgo } from '../lib/format.ts';
import type { Destination, Endpoint, EventPage, EventSummary, Stats } from '../types.ts';
import { endpointsKey } from './Endpoints.tsx';

const STATS_POLL_MS = 10_000;
/** The overview watches at most this many endpoints (one small request each per poll). */
const MAX_WATCHED = 8;

export const statsKey = (endpointId?: string) => ['stats', endpointId ?? 'all'] as const;

export function useStats(endpointId?: string) {
  return useQuery({
    queryKey: statsKey(endpointId),
    queryFn: () => get<Stats>(`/api/v1/stats${endpointId ? `?endpointId=${endpointId}` : ''}`),
    refetchInterval: STATS_POLL_MS,
  });
}

export function OverviewPage() {
  const stats = useStats();
  const endpoints = useQuery({
    queryKey: endpointsKey,
    queryFn: () => get<{ endpoints: Endpoint[] }>('/api/v1/endpoints'),
  });
  const watched = (endpoints.data?.endpoints ?? []).slice(0, MAX_WATCHED);

  const feeds = useQueries({
    queries: watched.map((e) => ({
      queryKey: ['recent-events', e.id],
      queryFn: () => get<EventPage>(`/api/v1/endpoints/${e.id}/events?limit=10`),
      refetchInterval: LIST_POLL_MS,
    })),
  });
  const dests = useQueries({
    queries: watched.map((e) => ({
      queryKey: ['destinations', e.id],
      queryFn: () => get<{ destinations: Destination[] }>(`/api/v1/endpoints/${e.id}/destinations`),
    })),
  });

  const feedStamp = feeds.map((f) => f.dataUpdatedAt).join(',');
  const recent = useMemo(
    () =>
      feeds
        .flatMap((f) => f.data?.events ?? [])
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0))
        .slice(0, 14),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- feedStamp changes when any feed does
    [feedStamp],
  );

  // New events since the page opened (the first load is history, not arrivals).
  const known = useRef<Set<string> | null>(null);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const allLoaded = feeds.length === watched.length && feeds.every((f) => f.isSuccess);
  useEffect(() => {
    if (!allLoaded) return;
    const ids = feeds.flatMap((f) => f.data?.events ?? []);
    if (known.current === null) {
      known.current = new Set(ids.map((e) => e.id));
      return;
    }
    const added = ids.filter((e) => !known.current!.has(e.id));
    if (added.length === 0) return;
    for (const e of added) known.current.add(e.id);
    setArrivals(added.map((e) => ({ key: e.id, endpointId: e.endpointId })));
    setFresh(new Set(added.map((e) => e.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the feeds change
  }, [feedStamp, allLoaded]);

  if (stats.isPending || endpoints.isPending) return <Spinner />;
  if (stats.isError || endpoints.isError)
    return <ErrorText error={stats.error ?? endpoints.error} />;

  const s = stats.data;
  const list = endpoints.data.endpoints;
  const names = new Map(list.map((e) => [e.id, e.name]));
  const destMap = Object.fromEntries(watched.map((e, i) => [e.id, dests[i]?.data?.destinations]));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            <LiveDot /> Live · refreshes every {STATS_POLL_MS / 1000} s
          </span>
        }
        title="Overview"
        description={`Traffic and delivery health across your ${list.length} ${list.length === 1 ? 'endpoint' : 'endpoints'}.`}
        actions={
          <Link to="/endpoints" className={buttonClass('secondary')}>
            Manage endpoints
          </Link>
        }
      />

      {list.length === 0 ? (
        <Onboarding />
      ) : (
        <>
          <Kpis s={s} />

          <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
            <section className="panel min-w-0 p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="eyebrow">Traffic · last 24 hours</p>
                  <p className="mt-1 text-sm text-muted">
                    Events received, and what each delivery attempt came back with.
                  </p>
                </div>
                <div className="flex gap-4 text-[11px] text-muted">
                  <Legend className="bg-ember-400" label="Events" line />
                  <Legend className="bg-mint-400" label="Delivered" />
                  <Legend className="bg-rose-400" label="Failed" />
                </div>
              </div>
              <TrafficChart series={s.series} />
            </section>

            <section className="panel flex min-w-0 flex-col p-5">
              <div className="mb-3 flex items-center justify-between">
                <p className="eyebrow">Activity</p>
                <span className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
                  <LiveDot tone="ember" /> every {LIST_POLL_MS / 1000} s
                </span>
              </div>
              <Feed events={recent} names={names} fresh={fresh} />
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.65fr_1fr]">
            <section className="panel min-w-0 p-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="eyebrow">Relay topology</p>
                <p className="text-[11px] text-dim">
                  A packet runs for every new event as it arrives.
                </p>
              </div>
              <Topology endpoints={watched} destinations={destMap} arrivals={arrivals} />
              {list.length > MAX_WATCHED && (
                <p className="mt-2 text-xs text-dim">Showing the first {MAX_WATCHED} endpoints.</p>
              )}
            </section>

            <div className="min-w-0 space-y-4">
              <section className="panel min-w-0 p-5">
                <p className="eyebrow mb-4">Deliveries · retained 7 days</p>
                <SegmentBar
                  segments={[
                    { label: 'Delivered', value: s.deliveries.succeeded, className: 'bg-mint-400' },
                    { label: 'Pending', value: s.deliveries.pending, className: 'bg-amber-400' },
                    { label: 'Sending', value: s.deliveries.inFlight, className: 'bg-ice-400' },
                    { label: 'Dead', value: s.deliveries.dead, className: 'bg-rose-400' },
                  ]}
                />
                <DeadReasons s={s} />
              </section>
              <section className="panel min-w-0 p-5">
                <p className="eyebrow mb-4">At the door</p>
                <dl className="space-y-3 text-sm">
                  <Line label="Events stored" value={s.events.stored} />
                  <Line
                    label="Duplicates absorbed"
                    value={s.events.duplicatesReceived}
                    hint="Provider retries matched by event id; not forwarded again."
                  />
                  <Line
                    label="Rejected signatures"
                    value={s.events.invalidSignature}
                    tone="rose"
                    hint="Stored for 24 h, never forwarded."
                  />
                  {s.events.invalidSignatureDroppedSinceStart > 0 && (
                    <Line
                      label="Dropped by rate limit"
                      value={s.events.invalidSignatureDroppedSinceStart}
                      tone="rose"
                      hint="Invalid requests over the limit since the server started."
                    />
                  )}
                </dl>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Kpis({ s }: { s: Stats }) {
  const a = s.attemptsLast24h;
  const pct =
    a.successRate === null ? '—' : `${(a.successRate * 100).toFixed(a.successRate === 1 ? 0 : 1)}%`;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label="Events · 24 h"
        value={s.events.last24h.toLocaleString()}
        spark={s.series.map((p) => p.events)}
        color="ember"
      >
        {s.events.stored.toLocaleString()} retained
      </Kpi>
      <div className="panel flex items-center gap-4 p-5">
        <div className="relative">
          <Ring value={a.successRate} />
        </div>
        <div className="min-w-0">
          <p className="eyebrow">Delivery success · 24 h</p>
          <p className="mt-1 font-mono text-2xl font-medium">{pct}</p>
          <p className="text-xs text-dim">
            {a.succeeded.toLocaleString()} of {a.total.toLocaleString()} attempts
          </p>
        </div>
      </div>
      <Kpi
        label="Latency p50 / p95"
        value={
          a.latencyMs.p50 === null ? (
            '—'
          ) : (
            <>
              {a.latencyMs.p50}
              <span className="text-base text-dim"> / {a.latencyMs.p95} ms</span>
            </>
          )
        }
        spark={s.series.map((p) => p.delivered + p.failed)}
        color="ice"
      >
        receiver response time, all attempts
      </Kpi>
      <Kpi
        label="Backlog"
        value={s.deliveries.due.toLocaleString()}
        accent={s.deliveries.due > 0 ? 'amber' : undefined}
        spark={s.series.map((p) => p.failed)}
        color="rose"
      >
        due now · {s.deliveries.dead} dead
      </Kpi>
    </div>
  );
}

function Kpi({
  label,
  value,
  children,
  spark,
  color,
  accent,
}: {
  label: string;
  value: ReactNode;
  children: ReactNode;
  spark: number[];
  color: ChartColor;
  accent?: 'amber';
}) {
  return (
    <div className="panel relative overflow-hidden p-5">
      <p className="eyebrow">{label}</p>
      <p
        className={`mt-2 font-mono text-[28px] leading-none font-medium tracking-tight ${accent === 'amber' ? 'text-amber-300' : ''}`}
      >
        {value}
      </p>
      <p className="mt-2 text-xs text-dim">{children}</p>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 opacity-70">
        <Sparkline values={spark} color={color} className="h-10 w-full" />
      </div>
    </div>
  );
}

function Legend({ className, label, line }: { className: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`${className} ${line ? 'h-0.5 w-3' : 'size-2 rounded-sm'}`} />
      {label}
    </span>
  );
}

function Line({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'rose';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <dt className="text-muted">{label}</dt>
      <dd className={`font-mono ${tone === 'rose' && value > 0 ? 'text-rose-300' : 'text-fg'}`}>
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

const REASON_LABEL: Record<string, string> = {
  exhausted: 'Out of attempts',
  non_retryable_status: 'Rejected (4xx)',
  redirect: 'Redirected',
  ssrf_blocked: 'Blocked address',
  destination_disabled: 'Destination off',
};

function DeadReasons({ s }: { s: Stats }) {
  const rows = Object.entries(s.deliveries.deadByReason).filter(([, n]) => n > 0);
  if (rows.length === 0) return null;
  return (
    <div className="mt-4 space-y-1.5 border-t border-ink-700/70 pt-3">
      {rows.map(([r, n]) => (
        <p key={r} className="flex items-center justify-between text-xs">
          <span className="text-muted">{REASON_LABEL[r] ?? r}</span>
          <span className="font-mono text-rose-300">{n}</span>
        </p>
      ))}
    </div>
  );
}

function Feed({
  events,
  names,
  fresh,
}: {
  events: EventSummary[];
  names: Map<string, string>;
  fresh: Set<string>;
}) {
  if (events.length === 0) {
    return (
      <div className="dot-grid grid flex-1 place-items-center rounded-lg border border-dashed border-ink-700 p-6 text-center">
        <div>
          <p className="text-sm">Waiting for the first event</p>
          <p className="mt-1 text-xs text-dim">
            Send a webhook to an endpoint and it appears here.
          </p>
        </div>
      </div>
    );
  }
  return (
    <ol className="-mx-2 max-h-[300px] flex-1 space-y-0.5 overflow-y-auto pr-1">
      {events.map((e) => (
        <li key={e.id}>
          <Link
            to={`/events/${e.id}`}
            className={`group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-ink-800 ${fresh.has(e.id) ? 'animate-flash' : ''}`}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                e.signatureStatus === 'invalid'
                  ? 'bg-rose-400'
                  : e.duplicateCount
                    ? 'bg-amber-400'
                    : 'bg-ember-400'
              }`}
            />
            <span className="w-11 shrink-0 font-mono text-[10.5px] text-ice-300">{e.method}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">
                {names.get(e.endpointId) ?? 'Endpoint'}
              </span>
              <span className="block truncate font-mono text-[10.5px] text-dim">
                {e.contentType ?? 'no content type'} · {formatBytes(e.sizeBytes)}
              </span>
            </span>
            {e.signatureStatus === 'invalid' && <Badge tone="red">invalid</Badge>}
            {e.duplicateCount > 0 && <Badge tone="amber">×{e.duplicateCount + 1}</Badge>}
            <span className="shrink-0 font-mono text-[10.5px] text-dim" title={e.receivedAt}>
              {timeAgo(e.receivedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function Onboarding() {
  const steps = [
    ['Create an endpoint', 'You get a secret ingest URL to give your webhook provider.'],
    ['Add a destination', 'Where events are forwarded, with signing, retries and backoff.'],
    ['Send an event', 'Watch it land here, then inspect every attempt.'],
  ];
  return (
    <section className="panel relative overflow-hidden p-8">
      <div
        aria-hidden="true"
        className="dot-grid absolute inset-0 [mask-image:linear-gradient(90deg,transparent,black)]"
      />
      <div className="relative max-w-xl space-y-6">
        <div className="space-y-2">
          <p className="eyebrow text-ember-400">Get started</p>
          <h2 className="text-2xl font-semibold tracking-tight">
            Your relay is ready. Give it something to carry.
          </h2>
        </div>
        <ol className="space-y-4">
          {steps.map(([t, b], i) => (
            <li key={t} className="flex gap-4">
              <span className="grid size-7 shrink-0 place-items-center rounded-full border border-ink-600 bg-ink-900 font-mono text-[11px] text-ember-300">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium">{t}</p>
                <p className="text-sm text-muted">{b}</p>
              </div>
            </li>
          ))}
        </ol>
        <Link to="/endpoints" className={buttonClass('primary')}>
          Create your first endpoint →
        </Link>
      </div>
    </section>
  );
}
