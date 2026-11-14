import { useQuery } from '@tanstack/react-query';
import { Link, Route, Routes } from 'react-router';
import { get } from './api.ts';

// Feature 1: the shell only. Pages (login, endpoints, events) arrive in the next features.

function HealthBadge() {
  const health = useQuery({
    queryKey: ['readyz'],
    queryFn: () => get<{ status: string }>('/readyz'),
    refetchInterval: 30_000,
  });
  const ok = health.data?.status === 'ok';
  const label = health.isPending ? 'checking…' : ok ? 'API + DB ok' : 'API unavailable';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
      }`}
    >
      {label}
    </span>
  );
}

function Home() {
  return (
    <section className="space-y-2">
      <h1 className="text-2xl font-semibold">Webhook relay</h1>
      <p className="text-slate-600">
        Receive webhooks, store them durably, forward them with retries, inspect and redeliver.
      </p>
    </section>
  );
}

function NotFound() {
  return (
    <section className="space-y-2">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link to="/" className="text-indigo-700 underline">
        Back to start
      </Link>
    </section>
  );
}

export function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            RelayForge
          </Link>
          <HealthBadge />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
