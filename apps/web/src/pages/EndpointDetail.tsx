import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { del, get, patch, post } from '../api.ts';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorText,
  Field,
  Spinner,
  errorMessage,
} from '../components/ui.tsx';
import type { Destination, Endpoint } from '../types.ts';
import { endpointsKey } from './Endpoints.tsx';

const endpointKey = (id: string) => ['endpoint', id] as const;
const destinationsKey = (id: string) => ['destinations', id] as const;

export function EndpointDetailPage() {
  const { endpointId = '' } = useParams();
  const endpoint = useQuery({
    queryKey: endpointKey(endpointId),
    queryFn: () => get<{ endpoint: Endpoint }>(`/api/v1/endpoints/${endpointId}`),
  });

  if (endpoint.isPending) return <Spinner />;
  if (endpoint.isError) {
    return (
      <div className="space-y-2">
        <ErrorText error={endpoint.error} />
        <Link to="/endpoints" className="text-sm text-indigo-700 underline">
          Back to endpoints
        </Link>
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link to="/endpoints" className="text-sm text-slate-500 hover:underline">
            ← Endpoints
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            {endpoint.name}
            {endpoint.paused ? (
              <Badge tone="amber">paused</Badge>
            ) : (
              <Badge tone="green">active</Badge>
            )}
          </h1>
        </div>
        <div className="flex gap-2">
          <Link
            to={`/endpoints/${endpoint.id}/events`}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
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
        </div>
      </div>
      <ErrorText error={togglePause.error ?? remove.error} />

      <Card className="space-y-2">
        <h2 className="font-medium">Ingest URL</h2>
        <p className="text-sm text-slate-600">
          Give this URL to your webhook provider. It is secret: anyone who has it can send events.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1.5 font-mono text-sm">
            {ingestUrl}
          </code>
          <CopyButton text={ingestUrl} />
        </div>
        {endpoint.paused && (
          <p className="text-sm text-amber-800">
            Paused: events are still received and stored, but nothing is forwarded until you resume.
          </p>
        )}
        <p className="text-xs text-slate-500">
          Signature verification:{' '}
          {endpoint.verification.scheme === 'none' ? 'off' : endpoint.verification.scheme}
          {endpoint.dedupeSource !== 'none' &&
            ` · de-duplication on ${endpoint.dedupeSource === 'header' ? 'header' : 'JSON field'} "${endpoint.dedupeName ?? ''}"`}
        </p>
      </Card>

      <Destinations endpointId={endpoint.id} />
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
      <h2 className="text-lg font-semibold">Destinations</h2>
      <p className="text-sm text-slate-600">
        Every event is forwarded to each enabled destination, with retries and backoff.
      </p>
      {destinations.isPending && <Spinner />}
      <ErrorText error={destinations.error} />
      {destinations.data?.destinations.length === 0 && (
        <p className="text-sm text-slate-600">
          No destinations: events are stored but not forwarded.
        </p>
      )}
      <ul className="space-y-2">
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
    <li>
      <Card className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm">{d.url}</p>
            <p className="text-xs text-slate-500">
              timeout {d.timeoutMs / 1000} s · up to {d.maxAttempts} attempts
            </p>
          </div>
          <div className="flex items-center gap-2">
            {d.enabled ? <Badge tone="green">enabled</Badge> : <Badge>disabled</Badge>}
            <Button variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
              {d.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remove destination ${d.url}?`)) remove.mutate();
              }}
            >
              Remove
            </Button>
          </div>
        </div>
        {error && <p className="text-sm text-red-700">{errorMessage(error)}</p>}
      </Card>
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
    <Card className="space-y-3">
      <h3 className="font-medium">Add a destination</h3>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem_auto] sm:items-end"
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
        <Button type="submit" disabled={add.isPending}>
          Add
        </Button>
      </form>
      <ErrorText error={add.error} />
      {secret && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">
            Signing secret — copy it now, it is shown only once here.
          </p>
          <p className="text-xs text-amber-900">
            Your receiver verifies X-RelayForge-Signature with it (Standard Webhooks algorithm).
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-sm">
              {secret}
            </code>
            <CopyButton text={secret} />
            <Button variant="secondary" onClick={() => setSecret(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
