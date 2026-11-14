import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { get } from '../api.ts';
import { Badge, Button, CopyButton, ErrorText, Spinner } from '../components/ui.tsx';
import { LIST_POLL_MS, useEventList } from '../events.ts';
import { formatBytes, timeAgo } from '../lib/format.ts';
import type { Endpoint, EventSummary } from '../types.ts';

export function EventsPage() {
  const { endpointId = '' } = useParams();
  const endpoint = useQuery({
    queryKey: ['endpoint', endpointId],
    queryFn: () => get<{ endpoint: Endpoint }>(`/api/v1/endpoints/${endpointId}`),
  });
  const list = useEventList(endpointId);
  const events = list.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link to={`/endpoints/${endpointId}`} className="text-sm text-slate-500 hover:underline">
          ← {endpoint.data?.endpoint.name ?? 'Endpoint'}
        </Link>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Events</h1>
          <span className="text-xs text-slate-500">
            {list.isFetching ? 'refreshing…' : `auto-refresh every ${LIST_POLL_MS / 1000} s`}
          </span>
        </div>
      </div>

      {list.isPending && <Spinner />}
      <ErrorText error={list.error ?? endpoint.error} />

      {list.isSuccess && events.length === 0 && endpoint.data && (
        <EmptyState ingestPath={endpoint.data.endpoint.ingestPath} />
      )}

      {events.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="px-3 py-2 font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Method</th>
                <th className="px-3 py-2 font-medium">Content type</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Signature</th>
                <th className="px-3 py-2 font-medium">Duplicates</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map((e) => (
                <EventRow key={e.id} event={e} />
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

function EventRow({ event: e }: { event: EventSummary }) {
  const href = `/events/${e.id}`;
  return (
    <tr className="hover:bg-slate-50">
      <td className="px-3 py-2 whitespace-nowrap">
        <Link to={href} className="text-indigo-700 hover:underline" title={e.receivedAt}>
          {timeAgo(e.receivedAt)}
        </Link>
      </td>
      <td className="px-3 py-2 font-mono text-xs">{e.method}</td>
      <td className="max-w-48 truncate px-3 py-2 text-slate-600">{e.contentType ?? '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatBytes(e.sizeBytes)}</td>
      <td className="px-3 py-2">
        <SignatureBadge status={e.signatureStatus} />
      </td>
      <td className="px-3 py-2 text-slate-600">{e.duplicateCount || '—'}</td>
    </tr>
  );
}

export function SignatureBadge({ status }: { status: EventSummary['signatureStatus'] }) {
  switch (status) {
    case 'valid':
      return <Badge tone="green">valid</Badge>;
    case 'invalid':
      return <Badge tone="red">invalid — not forwarded</Badge>;
    case 'not_checked':
      return <span className="whitespace-nowrap text-slate-400">not checked</span>;
  }
}

function EmptyState({ ingestPath }: { ingestPath: string }) {
  const command = `curl -X POST ${window.location.origin}${ingestPath} -H "content-type: application/json" -d "{\\"hello\\":\\"world\\"}"`;
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-slate-300 bg-white p-6">
      <p className="font-medium">No events yet</p>
      <p className="text-sm text-slate-600">
        Point a webhook provider at the ingest URL, or send a test event. It appears here within a
        few seconds.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1.5 font-mono text-xs">
          {command}
        </code>
        <CopyButton text={command} />
      </div>
    </div>
  );
}
