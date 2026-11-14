import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { get, post } from '../api.ts';
import { Badge, Button, Card, ErrorText, Field, Spinner } from '../components/ui.tsx';
import type { Endpoint } from '../types.ts';

export const endpointsKey = ['endpoints'] as const;

export function EndpointsPage() {
  const endpoints = useQuery({
    queryKey: endpointsKey,
    queryFn: () => get<{ endpoints: Endpoint[] }>('/api/v1/endpoints'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Endpoints</h1>
      </div>
      <CreateEndpoint />
      {endpoints.isPending && <Spinner />}
      <ErrorText error={endpoints.error} />
      {endpoints.data?.endpoints.length === 0 && (
        <p className="text-sm text-slate-600">
          No endpoints yet. Create one to get an ingest URL for your webhook provider.
        </p>
      )}
      <ul className="space-y-2">
        {endpoints.data?.endpoints.map((e) => (
          <li key={e.id}>
            <Link to={`/endpoints/${e.id}`} className="block">
              <Card className="flex items-center justify-between hover:border-indigo-300">
                <div>
                  <p className="font-medium">{e.name}</p>
                  <p className="font-mono text-xs text-slate-500">{e.ingestPath}</p>
                </div>
                <div className="flex gap-2">
                  {e.verification.scheme !== 'none' && <Badge>verifies signatures</Badge>}
                  {e.paused ? (
                    <Badge tone="amber">paused</Badge>
                  ) : (
                    <Badge tone="green">active</Badge>
                  )}
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
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
    <Card>
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name: name.trim() });
        }}
      >
        <div className="flex-1">
          <Field
            label="New endpoint"
            placeholder="e.g. GitHub — my-repo"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={create.isPending || !name.trim()}>
          Create
        </Button>
      </form>
      <div className="mt-2">
        <ErrorText error={create.error} />
      </div>
    </Card>
  );
}
