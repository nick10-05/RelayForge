// The signed-in layout: a fixed sidebar (drawer on small screens) and the page in an <Outlet>.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { get } from '../api.ts';
import { useLogout, useMe } from '../auth.tsx';
import { LiveDot, Wordmark } from './ui.tsx';

export function useHealth() {
  return useQuery({
    queryKey: ['readyz'],
    queryFn: () => get<{ status: string }>('/readyz'),
    refetchInterval: 30_000,
  });
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICONS = {
  overview: 'M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9',
  endpoints: 'M3 6h4m6 0h4M3 14h4m6 0h4M7 6c3 0 3 8 6 8M7 14c3 0 3-8 6-8',
  docs: 'M6 3h6l3 3v11H6zM12 3v3h3M8.5 10h4M8.5 13h4',
  external: 'M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8',
};

function NavItem({ to, icon, children }: { to: string; icon: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
          isActive ? 'bg-ink-800 text-fg' : 'text-muted hover:bg-ink-800/60 hover:text-fg'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute top-1/2 -left-3 h-5 w-[3px] -translate-y-1/2 rounded-r bg-ember-500 shadow-[0_0_12px_rgb(255_106_43/0.8)]" />
          )}
          <Icon d={icon} />
          {children}
        </>
      )}
    </NavLink>
  );
}

function HealthRow() {
  const health = useHealth();
  const ok = health.data?.status === 'ok';
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
      {health.isPending ? (
        <span className="size-2 rounded-full bg-ink-500" />
      ) : (
        <LiveDot tone={ok ? 'mint' : 'amber'} />
      )}
      <div className="min-w-0 leading-tight">
        <p className="text-xs font-medium">
          {health.isPending ? 'Checking…' : ok ? 'All systems operational' : 'API unavailable'}
        </p>
        <p className="font-mono text-[10px] text-dim">API · database · worker</p>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col gap-6 px-5 py-5" onClick={onNavigate}>
      <Link to="/overview" className="px-1">
        <Wordmark />
      </Link>
      <nav className="space-y-1">
        <p className="eyebrow px-3 pb-2">Workspace</p>
        <NavItem to="/overview" icon={ICONS.overview}>
          Overview
        </NavItem>
        <NavItem to="/endpoints" icon={ICONS.endpoints}>
          Endpoints
        </NavItem>
      </nav>
      <nav className="space-y-1">
        <p className="eyebrow px-3 pb-2">Developers</p>
        <a
          href="/api/v1/docs"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-ink-800/60 hover:text-fg"
        >
          <Icon d={ICONS.docs} />
          API reference
          <span className="ml-auto text-dim">
            <Icon d={ICONS.external} />
          </span>
        </a>
      </nav>
      <div className="mt-auto space-y-3">
        <HealthRow />
        {me.data && (
          <div className="flex items-center gap-3 px-1">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-ink-600 bg-gradient-to-br from-ink-700 to-ink-850 font-mono text-xs text-ember-300 uppercase">
              {me.data.email.slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-fg" title={me.data.email}>
                {me.data.email}
              </p>
              <button
                type="button"
                className="text-[11px] text-dim transition-colors hover:text-ember-300"
                disabled={logout.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  logout.mutate(undefined, { onSettled: () => void navigate('/login') });
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Shell() {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-ink-700/70 bg-ink-900/95 lg:block">
        <Sidebar />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-ink-700/70 bg-ink-900/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link to="/overview">
          <Wordmark />
        </Link>
        <button
          type="button"
          className="rounded-lg border border-ink-600 px-2.5 py-1.5 text-sm text-muted"
          aria-expanded={open}
          aria-label="Open navigation"
          onClick={() => setOpen(true)}
        >
          Menu
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 animate-rise border-r border-ink-700 bg-ink-900">
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      {/* A soft ember glow at the top of every page. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_60%_100%_at_70%_0%,rgb(255_106_43/0.07),transparent)] lg:left-64"
      />
      <main className="relative mx-auto max-w-6xl px-4 py-8 sm:px-8 lg:py-10">
        <Outlet />
      </main>
    </div>
  );
}
