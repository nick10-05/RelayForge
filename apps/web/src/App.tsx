import { Link, Navigate, Route, Routes } from 'react-router';
import { RequireAuth, useMe } from './auth.tsx';
import { Shell } from './components/Shell.tsx';
import { Spinner, Wordmark, buttonClass } from './components/ui.tsx';
import { EndpointDetailPage } from './pages/EndpointDetail.tsx';
import { EndpointsPage } from './pages/Endpoints.tsx';
import { EventDetailPage } from './pages/EventDetail.tsx';
import { EventsPage } from './pages/Events.tsx';
import { LandingPage } from './pages/Landing.tsx';
import { LoginPage } from './pages/Login.tsx';
import { OverviewPage } from './pages/Overview.tsx';

/** The front page for visitors; signed-in users go straight to their overview. */
function Home() {
  const me = useMe();
  if (me.isPending) return <Spinner />;
  if (me.data) return <Navigate to="/overview" replace />;
  return <LandingPage />;
}

function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="space-y-5 text-center">
        <Link to="/" className="inline-block">
          <Wordmark />
        </Link>
        <p className="font-mono text-6xl font-medium text-ember-400">404</p>
        <p className="text-muted">This route doesn&apos;t lead anywhere.</p>
        <Link to="/" className={buttonClass('secondary')}>
          Back to start
        </Link>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage mode="login" />} />
      <Route path="/signup" element={<LoginPage mode="signup" />} />
      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/endpoints" element={<EndpointsPage />} />
        <Route path="/endpoints/:endpointId" element={<EndpointDetailPage />} />
        <Route path="/endpoints/:endpointId/events" element={<EventsPage />} />
        <Route path="/events/:eventId" element={<EventDetailPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
