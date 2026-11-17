import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { get, post } from '../api.ts';
import { Sparkline } from '../components/charts.tsx';
import { Badge, Button, ErrorText, PageHeader, Spinner } from '../components/ui.tsx';
import type { Endpoint, Stats } from '../types.ts';

export const endpointsKey = ['endpoints'] as const;

export function EndpointsPage() {
  const endpoints = useQuery({
    queryKey: endpointsKey,
    queryFn: () => get<{ endpoints: Endpoint[] }>('/api/v1/endpoints'),
  });
  const list = endpoints.data?.endpoints ?? [];
  // Per-endpoint numbers for the cards (same query keys as the endpoint page uses).
  const stats = useQueries({
    queries: list.map((e) => ({
      queryKey: ['stats', e.id],
      queryFn: () => get<Stats>(`/api/v1/stats?endpointId=${e.id}`),
      refetchInterval: 15_000,
    })),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        title="Endpoints"
        description="Each endpoint has a secret ingest URL. Events that arrive there are stored, then forwarded to its destinations."
      />
      <CreateEndpoint />
      {endpoints.isPending && <Spinner />}
      <ErrorText error={endpoints.error} />
      {endpoints.isSuccess && list.length === 0 && (
        <p className="rounded-xl border border-dashed border-ink-700 p-8 text-center text-sm text-muted">
          No endpoints yet. Name one above to get an ingest URL for your webhook provider.
        </p>
      )}
      <ul className="grid gap-4 md:grid-cols-2">
        {list.map((e, i) => (
          <li key={e.id} className="animate-rise" style={{ animationDelay: `${i * 40}ms` }}>
            <EndpointCard endpoint={e} stats={stats[i]?.data} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EndpointCard({ endpoint: e, stats }: { endpoint: Endpoint; stats: Stats | undefined }) {
  const rate = stats?.attemptsLast24h.successRate;
  return (
    <Link
      to={`/endpoints/${e.id}`}
      className="panel group block overflow-hidden transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-ink-500"
    >
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium tracking-tight group-hover:text-ember-200">
              {e.name}
            </p>
            <p className="mt-1 truncate font-mono text-[11px] text-dim">{e.ingestPath}</p>
          </div>
          {e.paused ? (
            <Badge tone="amber" dot>
              paused
            </Badge>
          ) : (
            <Badge tone="green" dot>
              live
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {e.verification.scheme !== 'none' && (
            <Badge tone="ice">
              {e.verification.scheme === 'hmac' ? 'HMAC verified' : 'Standard Webhooks'}
            </Badge>
          )}
          {e.dedupeSource !== 'none' && <Badge tone="slate">dedupe · {e.dedupeName}</Badge>}
        </div>
        <dl className="grid grid-cols-3 gap-3 border-t border-ink-700/70 pt-4">
          <Metric label="24 h events" value={stats ? stats.events.last24h.toLocaleString() : '…'} />
          <Metric
            label="success"
            value={stats ? (rate == null ? '—' : `${Math.round(rate * 100)}%`) : '…'}
            tone={rate != null && rate < 0.9 ? 'rose' : undefined}
          />
          <Metric
            label="dead"
            value={stats ? String(stats.deliveries.dead) : '…'}
            tone={stats && stats.deliveries.dead > 0 ? 'rose' : undefined}
          />
        </dl>
      </div>
      <div className="h-10 border-t border-ink-700/40 opacity-80">
        {stats && <Sparkline values={stats.series.map((p) => p.events)} className="h-10 w-full" />}
      </div>
    </Link>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'rose' }) {
  return (
    <div>
      <dt className="text-[10.5px] text-dim">{label}</dt>
      <dd className={`font-mono text-base ${tone === 'rose' ? 'text-rose-300' : 'text-fg'}`}>
        {value}
      </dd>
    </div>
  );
}

function CreateEndpoint() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: (body: { name: string }) => post<{ endpoint: Endpoint }>('/api/v1/endpoints', body),
    onSuccess: ({ endpoint }) => {
      void queryClient.invalidateQueries({ queryKey: endpointsKey });
      void navigate(`/endpoints/${endpoint.id}`);
    },
  });

  return (
    <div className="panel p-2">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name: name.trim() });
        }}
      >
        <label className="sr-only" htmlFor="new-endpoint">
          New endpoint name
        </label>
        <input
          id="new-endpoint"
          className="min-w-0 flex-1 rounded-lg bg-transparent px-3 py-2 text-sm placeholder:text-dim focus:outline-none"
          placeholder="Name a new endpoint, e.g. “GitHub · my-repo”"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={create.isPending || !name.trim()}>
          Create endpoint
        </Button>
      </form>
      {create.error != null && (
        <div className="px-3 pb-2">
          <ErrorText error={create.error} />
        </div>
      )}
    </div>
  );
}
