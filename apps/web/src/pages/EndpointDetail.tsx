import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { del, get, patch, post } from '../api.ts';
import { Sparkline } from '../components/charts.tsx';
import { Topology } from '../components/Topology.tsx';
import type { Arrival } from '../components/Topology.tsx';
import {
  Badge,
  Button,
  CodeLine,
  CopyButton,
  ErrorText,
  Field,
  PageHeader,
  Spinner,
  buttonClass,
  errorMessage,
} from '../components/ui.tsx';
import { LIST_POLL_MS } from '../events.ts';
import type { Destination, Endpoint, EventPage } from '../types.ts';
import { endpointsKey } from './Endpoints.tsx';
import { InboundSettings } from './InboundSettings.tsx';
import { useStats } from './Overview.tsx';

const endpointKey = (id: string) => ['endpoint', id] as const;
const destinationsKey = (id: string) => ['destinations', id] as const;

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1.5 text-xs text-dim transition-colors hover:text-fg"
    >
      <span aria-hidden="true">←</span> {children}
    </Link>
  );
}

export function EndpointDetailPage() {
  const { endpointId = '' } = useParams();
  const endpoint = useQuery({
    queryKey: endpointKey(endpointId),
    queryFn: () => get<{ endpoint: Endpoint }>(`/api/v1/endpoints/${endpointId}`),
  });

  if (endpoint.isPending) return <Spinner />;
  if (endpoint.isError) {
    return (
      <div className="space-y-3">
        <ErrorText error={endpoint.error} />
        <BackLink to="/endpoints">Back to endpoints</BackLink>
      </div>
    );
  }
  return <EndpointView endpoint={endpoint.data.endpoint} />;
}

function EndpointView({ endpoint }: { endpoint: Endpoint }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const ingestUrl = `${window.location.origin}${endpoint.ingestPath}`;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: endpointKey(endpoint.id) });
    void queryClient.invalidateQueries({ queryKey: endpointsKey });
  };
  const togglePause = useMutation({
    mutationFn: () => patch(`/api/v1/endpoints/${endpoint.id}`, { paused: !endpoint.paused }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/v1/endpoints/${endpoint.id}`),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: endpointKey(endpoint.id) });
      void queryClient.invalidateQueries({ queryKey: endpointsKey });
      void navigate('/endpoints', { replace: true });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        back={<BackLink to="/endpoints">Endpoints</BackLink>}
        eyebrow="Endpoint"
        title={
          <>
            {endpoint.name}
            {endpoint.paused ? (
              <Badge tone="amber" dot>
                paused
              </Badge>
            ) : (
              <Badge tone="green" dot>
                live
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <Link to={`/endpoints/${endpoint.id}/events`} className={buttonClass('primary')}>
              View events
            </Link>
            <Button
              variant="secondary"
              disabled={togglePause.isPending}
              onClick={() => togglePause.mutate()}
            >
              {endpoint.paused ? 'Resume deliveries' : 'Pause deliveries'}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete "${endpoint.name}" with all its events? This cannot be undone.`,
                  )
                ) {
                  remove.mutate();
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      />
      <ErrorText error={togglePause.error ?? remove.error} />

      <section className="panel space-y-3 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="eyebrow">Ingest URL</p>
          <p className="text-xs text-dim">Secret: anyone who has it can send events.</p>
        </div>
        <CodeLine value={ingestUrl} prompt="POST" />
        {endpoint.paused && (
          <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-sm text-amber-300">
            Paused: events are still received and stored, but nothing is forwarded until you resume.
          </p>
        )}
      </section>

      <Health endpoint={endpoint} />

      <InboundSettings endpoint={endpoint} onSaved={refresh} />

      <Destinations endpointId={endpoint.id} />
    </div>
  );
}

/** This endpoint's numbers and its own relay graph, both from real data. */
function Health({ endpoint }: { endpoint: Endpoint }) {
  const stats = useStats(endpoint.id);
  const destinations = useQuery({
    queryKey: destinationsKey(endpoint.id),
    queryFn: () =>
      get<{ destinations: Destination[] }>(`/api/v1/endpoints/${endpoint.id}/destinations`),
  });
  const recent = useQuery({
    queryKey: ['recent-events', endpoint.id],
    queryFn: () => get<EventPage>(`/api/v1/endpoints/${endpoint.id}/events?limit=10`),
    refetchInterval: LIST_POLL_MS,
  });

  const known = useRef<Set<string> | null>(null);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  useEffect(() => {
    const events = recent.data?.events;
    if (!events) return;
    if (known.current === null) {
      known.current = new Set(events.map((e) => e.id));
      return;
    }
    const added = events.filter((e) => !known.current!.has(e.id));
    for (const e of added) known.current.add(e.id);
    if (added.length) setArrivals(added.map((e) => ({ key: e.id, endpointId: e.endpointId })));
  }, [recent.data]);

  const s = stats.data;
  const rate = s?.attemptsLast24h.successRate;
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-ink-700/60 p-0">
        <Cell
          label="Events · 24 h"
          value={s?.events.last24h.toLocaleString()}
          spark={s?.series.map((p) => p.events)}
        />
        <Cell
          label="Success · 24 h"
          value={
            s ? (rate == null ? '—' : `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%`) : undefined
          }
          spark={s?.series.map((p) => p.delivered)}
          color="mint"
        />
        <Cell
          label="Latency p50 / p95"
          value={
            s
              ? s.attemptsLast24h.latencyMs.p50 === null
                ? '—'
                : `${s.attemptsLast24h.latencyMs.p50} / ${s.attemptsLast24h.latencyMs.p95} ms`
              : undefined
          }
        />
        <Cell
          label="Backlog · dead"
          value={s ? `${s.deliveries.due} · ${s.deliveries.dead}` : undefined}
          spark={s?.series.map((p) => p.failed)}
          color="rose"
        />
      </div>
      <div className="panel p-5">
        <div className="mb-1 flex items-center justify-between">
          <p className="eyebrow">Route</p>
          <p className="text-[11px] text-dim">Live: a packet runs per new event.</p>
        </div>
        <Topology
          endpoints={[endpoint]}
          destinations={{ [endpoint.id]: destinations.data?.destinations }}
          arrivals={arrivals}
        />
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  spark,
  color = 'ember',
}: {
  label: string;
  value: string | undefined;
  spark?: number[] | undefined;
  color?: 'ember' | 'mint' | 'rose';
}) {
  return (
    <div className="relative overflow-hidden bg-ink-850 p-4">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 font-mono text-xl">{value ?? '…'}</p>
      {spark && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 opacity-60">
          <Sparkline values={spark} color={color} className="h-8 w-full" />
        </div>
      )}
    </div>
  );
}

function Destinations({ endpointId }: { endpointId: string }) {
  const queryClient = useQueryClient();
  const destinations = useQuery({
    queryKey: destinationsKey(endpointId),
    queryFn: () =>
      get<{ destinations: Destination[] }>(`/api/v1/endpoints/${endpointId}/destinations`),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: destinationsKey(endpointId) });

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Destinations</h2>
        <p className="text-sm text-muted">
          Every event is forwarded to each enabled destination, signed, with retries and backoff.
        </p>
      </div>
      {destinations.isPending && <Spinner />}
      <ErrorText error={destinations.error} />
      {destinations.data?.destinations.length === 0 && (
        <p className="rounded-xl border border-dashed border-ink-700 p-5 text-sm text-muted">
          No destinations: events are stored but not forwarded.
        </p>
      )}
      <ul className="panel divide-y divide-ink-700/70 overflow-hidden p-0 empty:hidden">
        {destinations.data?.destinations.map((d) => (
          <DestinationRow key={d.id} destination={d} onChange={refresh} />
        ))}
      </ul>
      <AddDestination endpointId={endpointId} onAdded={refresh} />
    </section>
  );
}

function DestinationRow({
  destination: d,
  onChange,
}: {
  destination: Destination;
  onChange: () => void;
}) {
  const base = `/api/v1/endpoints/${d.endpointId}/destinations/${d.id}`;
  const toggle = useMutation({
    mutationFn: () => patch(base, { enabled: !d.enabled }),
    onSuccess: onChange,
  });
  const remove = useMutation({ mutationFn: () => del(base), onSuccess: onChange });
  const error = toggle.error ?? remove.error;

  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`size-2 shrink-0 rounded-full ${d.enabled ? 'bg-mint-400 shadow-[0_0_8px_rgb(79_227_161/0.7)]' : 'bg-ink-500'}`}
          />
          <div className="min-w-0">
            <p className="truncate font-mono text-[13px]" title={d.url}>
              {d.url}
            </p>
            <p className="text-xs text-dim">
              timeout {d.timeoutMs / 1000} s · up to {d.maxAttempts} attempts
              {!d.enabled && ' · disabled'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
            {d.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="ghost"
            className="hover:text-rose-300"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Remove destination ${d.url}?`)) remove.mutate();
            }}
          >
            Remove
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-rose-300">{errorMessage(error)}</p>}
    </li>
  );
}

function AddDestination({ endpointId, onAdded }: { endpointId: string; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('10');
  const [maxAttempts, setMaxAttempts] = useState('10');
  // Shown once, right after creation; never stored in the cache or the URL.
  const [secret, setSecret] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      post<{ destination: Destination; signingSecret: string }>(
        `/api/v1/endpoints/${endpointId}/destinations`,
        {
          url: url.trim(),
          timeoutMs: Number(timeoutSeconds) * 1000,
          maxAttempts: Number(maxAttempts),
        },
      ),
    onSuccess: ({ signingSecret }) => {
      setSecret(signingSecret);
      setUrl('');
      onAdded();
    },
  });

  return (
    <div className="panel space-y-4 p-5">
      <p className="eyebrow">Add a destination</p>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_7rem_7rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setSecret(null);
          add.mutate();
        }}
      >
        <Field
          label="URL"
          type="url"
          placeholder="https://example.com/webhooks"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Field
          label="Timeout (s)"
          type="number"
          min={1}
          max={15}
          required
          value={timeoutSeconds}
          onChange={(e) => setTimeoutSeconds(e.target.value)}
        />
        <Field
          label="Max attempts"
          type="number"
          min={1}
          max={15}
          required
          value={maxAttempts}
          onChange={(e) => setMaxAttempts(e.target.value)}
        />
        <Button type="submit" className="py-2" disabled={add.isPending}>
          Add
        </Button>
      </form>
      <ErrorText error={add.error} />
      {secret && (
        <div className="animate-rise space-y-3 rounded-lg border border-ember-500/40 bg-ember-500/[0.06] p-4">
          <div>
            <p className="text-sm font-medium text-ember-200">
              Signing secret: copy it now, it is shown only once.
            </p>
            <p className="mt-1 text-xs text-muted">
              Your receiver verifies <code className="text-ember-300">X-RelayForge-Signature</code>{' '}
              with it (Standard Webhooks algorithm).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-[13px]">
              {secret}
            </code>
            <CopyButton text={secret} />
            <Button variant="ghost" onClick={() => setSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
