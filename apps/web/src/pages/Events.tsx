import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { get } from '../api.ts';
import {
  Badge,
  Button,
  CodeLine,
  ErrorText,
  LiveDot,
  PageHeader,
  Spinner,
} from '../components/ui.tsx';
import { LIST_POLL_MS, useEventList } from '../events.ts';
import { formatBytes, timeAgo } from '../lib/format.ts';
import type { Endpoint, EventSummary } from '../types.ts';
import { BackLink } from './EndpointDetail.tsx';

export function EventsPage() {
  const { endpointId = '' } = useParams();
  const endpoint = useQuery({
    queryKey: ['endpoint', endpointId],
    queryFn: () => get<{ endpoint: Endpoint }>(`/api/v1/endpoints/${endpointId}`),
  });
  const list = useEventList(endpointId);
  const events = list.data?.pages.flatMap((p) => p.events) ?? [];

  // Highlight rows that arrive while the page is open.
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const firstIds = list.data?.pages[0]?.events.map((e) => e.id).join(',');
  useEffect(() => {
    const ids = firstIds ? firstIds.split(',') : [];
    if (!list.isSuccess) return;
    if (known.current === null) {
      known.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !known.current!.has(id));
    for (const id of added) known.current.add(id);
    if (added.length) setFresh(new Set(added));
  }, [firstIds, list.isSuccess]);

  return (
    <div className="space-y-6">
      <PageHeader
        back={
          <BackLink to={`/endpoints/${endpointId}`}>
            {endpoint.data?.endpoint.name ?? 'Endpoint'}
          </BackLink>
        }
        eyebrow={
          <span className="flex items-center gap-2">
            <LiveDot tone="ember" />
            {list.isFetching ? 'Refreshing…' : `Live · every ${LIST_POLL_MS / 1000} s`}
          </span>
        }
        title="Events"
        description="Newest first. Open an event for its body, headers, deliveries and every attempt."
      />

      {list.isPending && <Spinner />}
      <ErrorText error={list.error ?? endpoint.error} />

      {list.isSuccess && events.length === 0 && endpoint.data && (
        <EmptyState ingestPath={endpoint.data.endpoint.ingestPath} />
      )}

      {events.length > 0 && (
        <div className="panel overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-ink-700/80 text-dim">
                {['Received', 'Method', 'Content type', 'Size', 'Signature', 'Duplicates'].map(
                  (h) => (
                    <th key={h} className="eyebrow px-4 py-3 font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/50">
              {events.map((e) => (
                <EventRow key={e.id} event={e} fresh={fresh.has(e.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.hasNextPage && (
        <Button
          variant="secondary"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? 'Loading…' : 'Load older events'}
        </Button>
      )}
    </div>
  );
}

function EventRow({ event: e, fresh }: { event: EventSummary; fresh: boolean }) {
  const href = `/events/${e.id}`;
  const navigate = useNavigate();
  return (
    <tr
      className={`group cursor-pointer transition-colors hover:bg-ink-800/70 ${fresh ? 'animate-flash' : ''}`}
      onClick={() => void navigate(href)}
    >
      <td className="px-4 py-2.5 whitespace-nowrap">
        <Link
          to={href}
          className="flex items-center gap-2.5 text-fg group-hover:text-ember-200"
          title={e.receivedAt}
        >
          <span
            className={`size-1.5 rounded-full ${e.signatureStatus === 'invalid' ? 'bg-rose-400' : 'bg-ember-400'}`}
          />
          {timeAgo(e.receivedAt)}
        </Link>
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-ice-300">{e.method}</td>
      <td className="max-w-56 truncate px-4 py-2.5 font-mono text-xs text-muted">
        {e.contentType ?? '—'}
      </td>
      <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap text-muted">
        {formatBytes(e.sizeBytes)}
      </td>
      <td className="px-4 py-2.5">
        <SignatureBadge status={e.signatureStatus} />
      </td>
      <td className="px-4 py-2.5 font-mono text-xs text-muted">
        {e.duplicateCount ? <Badge tone="amber">+{e.duplicateCount}</Badge> : '—'}
      </td>
    </tr>
  );
}

export function SignatureBadge({ status }: { status: EventSummary['signatureStatus'] }) {
  switch (status) {
    case 'valid':
      return (
        <Badge tone="green" dot>
          valid
        </Badge>
      );
    case 'invalid':
      return (
        <Badge tone="red" dot>
          invalid · not forwarded
        </Badge>
      );
    case 'not_checked':
      return <span className="text-xs whitespace-nowrap text-dim">not checked</span>;
  }
}

function EmptyState({ ingestPath }: { ingestPath: string }) {
  const command = `curl -X POST ${window.location.origin}${ingestPath} -H "content-type: application/json" -d "{\\"hello\\":\\"world\\"}"`;
  return (
    <div className="panel dot-grid space-y-4 p-8">
      <div className="space-y-1">
        <p className="flex items-center gap-2 font-medium">
          <LiveDot tone="ember" /> Listening for the first event
        </p>
        <p className="text-sm text-muted">
          Point a webhook provider at the ingest URL, or send a test event. It appears here within a
          few seconds.
        </p>
      </div>
      <CodeLine value={command} prompt="$" />
    </div>
  );
}
