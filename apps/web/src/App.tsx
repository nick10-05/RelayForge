import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router';
import { get } from './api.ts';
import { RequireAuth, useLogout, useMe } from './auth.tsx';
import { Badge, Button, Spinner } from './components/ui.tsx';
import { EndpointDetailPage } from './pages/EndpointDetail.tsx';
import { EndpointsPage } from './pages/Endpoints.tsx';
import { EventDetailPage } from './pages/EventDetail.tsx';
import { EventsPage } from './pages/Events.tsx';
import { LoginPage } from './pages/Login.tsx';

function HealthBadge() {
  const health = useQuery({
    queryKey: ['readyz'],
    queryFn: () => get<{ status: string }>('/readyz'),
    refetchInterval: 30_000,
  });
  if (health.isPending) return <Badge>checking…</Badge>;
  return health.data?.status === 'ok' ? (
    <Badge tone="green">API + DB ok</Badge>
  ) : (
    <Badge tone="amber">API unavailable</Badge>
  );
}

function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  if (!me.data) return null;
  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-slate-600 sm:inline">{me.data.email}</span>
      <Button
        variant="secondary"
        disabled={logout.isPending}
        onClick={() => logout.mutate(undefined, { onSettled: () => void navigate('/login') })}
      >
        Log out
      </Button>
    </div>
  );
}

function Home() {
  const me = useMe();
  if (me.isPending) return <Spinner />;
  if (me.data) return <Navigate to="/endpoints" replace />;
  return (
    <section className="mx-auto max-w-xl space-y-4 py-8 text-center">
      <h1 className="text-3xl font-semibold">Webhook relay and inspector</h1>
      <p className="text-slate-600">
        Receive webhooks, store them durably, forward them with retries and backoff, then inspect
        and redeliver any event.
      </p>
      <div className="flex justify-center gap-3">
        <Link
          to="/signup"
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Create an account
        </Link>
        <Link
          to="/login"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium"
        >
          Log in
        </Link>
      </div>
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
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link to="/" className="font-semibold tracking-tight">
              RelayForge
            </Link>
            <HealthBadge />
          </div>
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<LoginPage mode="login" />} />
          <Route path="/signup" element={<LoginPage mode="signup" />} />
          <Route
            path="/endpoints"
            element={
              <RequireAuth>
                <EndpointsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/endpoints/:endpointId"
            element={
              <RequireAuth>
                <EndpointDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/endpoints/:endpointId/events"
            element={
              <RequireAuth>
                <EventsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/events/:eventId"
            element={
              <RequireAuth>
                <EventDetailPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
