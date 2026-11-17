// The public front page. Everything it states is a real property of this system (design.md
// defaults, the delivery engine's guarantees); it shows no traffic numbers, because a visitor
// has no account whose real numbers could be shown.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Globe } from '../components/globe/Globe.tsx';
import { useHealth } from '../components/Shell.tsx';
import { LiveDot, Wordmark, buttonClass } from '../components/ui.tsx';

const REPO = 'https://github.com/nick10-05/RelayForge';

function StatusChip() {
  const health = useHealth();
  const ok = health.data?.status === 'ok';
  return (
    <a
      href="/readyz"
      className="inline-flex items-center gap-2 rounded-full border border-ink-600 bg-ink-850/80 py-1 pr-3 pl-2 text-xs text-muted backdrop-blur transition-colors hover:border-ink-500"
    >
      {health.isPending ? (
        <span className="size-2 rounded-full bg-ink-500" />
      ) : (
        <LiveDot tone={ok ? 'mint' : 'amber'} />
      )}
      {health.isPending
        ? 'Checking live status…'
        : ok
          ? 'Live in Singapore · API and database healthy'
          : 'Status: API unavailable'}
    </a>
  );
}

function Nav() {
  return (
    <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
      <Link to="/">
        <Wordmark />
      </Link>
      <nav className="hidden items-center gap-7 text-sm text-muted md:flex">
        <a href="#how" className="transition-colors hover:text-fg">
          How it works
        </a>
        <a href="#reliability" className="transition-colors hover:text-fg">
          Reliability
        </a>
        <a href="#security" className="transition-colors hover:text-fg">
          Security
        </a>
        <a href="/api/v1/docs" className="transition-colors hover:text-fg">
          API reference
        </a>
      </nav>
      <div className="flex items-center gap-2">
        <Link to="/login" className={buttonClass('ghost')}>
          Sign in
        </Link>
        <Link to="/signup" className={buttonClass('primary')}>
          Start free
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative">
      <div
        aria-hidden="true"
        className="dot-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_70%_60%_at_60%_40%,black,transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[-10%] right-[-10%] h-[700px] w-[900px] bg-[radial-gradient(closest-side,rgb(91_134_240/0.12),transparent)]"
      />
      <div className="relative mx-auto grid max-w-7xl items-center gap-6 px-5 pt-6 pb-10 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pt-10">
        <div className="animate-rise space-y-7">
          <StatusChip />
          <h1 className="text-[44px] leading-[1.02] font-semibold tracking-[-0.035em] sm:text-6xl lg:text-[72px]">
            Every webhook,
            <br />
            <span className="font-display text-[1.08em] font-normal tracking-[-0.01em] italic">
              <span className="text-ember-gradient">delivered.</span>
            </span>
          </h1>
          <p className="max-w-xl text-lg leading-relaxed text-muted">
            RelayForge sits between webhook providers and your services. It stores every request
            durably <em className="text-fg not-italic">before</em> answering, forwards it with
            retries, backoff and a dead-letter queue, and lets you inspect and replay any event,
            byte for byte.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/signup" className={buttonClass('primary', 'px-5 py-2.5 text-[15px]')}>
              Create an endpoint
              <span aria-hidden="true">→</span>
            </Link>
            <a href="/api/v1/docs" className={buttonClass('secondary', 'px-5 py-2.5 text-[15px]')}>
              Read the API reference
            </a>
          </div>
          <dl className="grid max-w-xl grid-cols-2 gap-x-6 gap-y-4 border-t border-ink-700/70 pt-6 sm:grid-cols-4">
            {[
              ['202', 'only after commit'],
              ['10', 'attempts, full jitter'],
              ['1 MB', 'body limit'],
              ['7 days', 'event retention'],
            ].map(([v, l]) => (
              <div key={l}>
                <dt className="font-mono text-xl font-medium text-fg">{v}</dt>
                <dd className="mt-0.5 text-xs text-dim">{l}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="relative mx-auto aspect-square w-full max-w-[640px] lg:-mr-10">
          <Globe />
          <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-full border border-ink-700 bg-ink-900/80 px-4 py-1.5 font-mono text-[10.5px] text-muted backdrop-blur">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-ice-400" /> inbound
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-ember-400" /> delivery
            </span>
            <span className="text-dim">drag to rotate</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const STAGES = [
  {
    n: '01',
    title: 'Ingest',
    body: 'A provider POSTs to your secret URL. Raw bytes are kept exactly as sent, up to 1 MB. Signatures are checked (HMAC or Standard Webhooks) and repeats are de-duplicated by event id.',
    code: 'POST /in/{slug}',
  },
  {
    n: '02',
    title: 'Persist',
    body: 'The event and one delivery per destination are written in a single transaction. Only after the commit does the provider get 202, so an accepted webhook is never lost.',
    code: '202 { eventId }',
  },
  {
    n: '03',
    title: 'Deliver',
    body: 'Workers claim due deliveries with SKIP LOCKED, sign them, and send them through an SSRF-safe client. Failures back off with full jitter; Retry-After is honoured.',
    code: 'X-RelayForge-Signature',
  },
  {
    n: '04',
    title: 'Inspect',
    body: 'Every attempt is recorded: status, latency, response headers and body. Retry a dead delivery or replay the whole event, and a double click never sends it twice.',
    code: 'POST /events/{id}/replay',
  },
];

function Pipeline() {
  return (
    <section id="how" className="relative mx-auto max-w-7xl scroll-mt-10 px-5 py-20 sm:px-8">
      <SectionTitle eyebrow="How it works" title="The path of a webhook">
        Four steps, each with one job. The provider gets its answer quickly; your service gets the
        event when it is ready for it.
      </SectionTitle>
      <div className="relative mt-12">
        {/* The rail with a packet running along it (desktop). */}
        <div
          aria-hidden="true"
          className="absolute top-[30px] right-[12%] left-[12%] hidden lg:block"
        >
          <div className="h-px bg-gradient-to-r from-ice-400/40 via-ink-600 to-ember-500/50" />
          <span className="absolute -top-[3px] size-[7px] animate-[travel_4.5s_cubic-bezier(.6,.05,.3,1)_infinite] rounded-full bg-ember-300 shadow-[0_0_14px_3px_rgb(255_106_43/0.7)]" />
        </div>
        <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {STAGES.map((s) => (
            <li key={s.n} className="panel relative p-5">
              <div className="mb-5 flex items-center gap-3">
                <span className="grid size-[42px] place-items-center rounded-full border border-ink-600 bg-ink-900 font-mono text-xs text-ember-300 shadow-[0_0_0_6px_var(--color-ink-950)]">
                  {s.n}
                </span>
                <h3 className="text-lg font-semibold tracking-tight">{s.title}</h3>
              </div>
              <p className="text-sm leading-relaxed text-muted">{s.body}</p>
              <code className="mt-4 inline-block rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-[11px] text-ice-300">
                {s.code}
              </code>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** Retry ceilings from the engine's policy: min(1 h, 30 s × 2^(n−1)). */
const CEILINGS = Array.from({ length: 9 }, (_, i) => Math.min(3600, 30 * 2 ** i));
const fmt = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : '1 h');

function Reliability() {
  const max = 3600;
  return (
    <section
      id="reliability"
      className="relative scroll-mt-10 border-y border-ink-700/60 bg-ink-900/40"
    >
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-8">
          <SectionTitle eyebrow="Reliability" title="Built for the bad day">
            Receivers go down, deploys restart workers, providers retry. The engine assumes all of
            it.
          </SectionTitle>
          <ul className="space-y-5">
            {[
              [
                'Leases with fencing',
                'A claimed delivery carries a lease and an attempt number. A worker that stalls and comes back late can no longer overwrite the result.',
              ],
              [
                'Postgres as the queue',
                'FOR UPDATE SKIP LOCKED lets many workers claim in parallel without double sends, with no broker to run or lose.',
              ],
              [
                'Dead letters you can act on',
                'After the last attempt, or on a status retrying cannot fix, a delivery is marked dead with its reason, ready to retry from the dashboard.',
              ],
            ].map(([t, b]) => (
              <li key={t} className="flex gap-4">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-ember-500 shadow-[0_0_10px_rgb(255_106_43/0.8)]" />
                <div>
                  <p className="font-medium">{t}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{b}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <figure className="panel self-start p-6">
          <div className="flex items-baseline justify-between gap-4">
            <p className="eyebrow">Retry schedule</p>
            <p className="font-mono text-[11px] text-dim">delay = random(0, min(1 h, 30 s·2ⁿ⁻¹))</p>
          </div>
          <div
            className="mt-6 flex h-56 items-end gap-2.5"
            role="img"
            aria-label="Retry delay ceilings for attempts 2 to 10, from 30 seconds doubling up to a 1 hour cap"
          >
            {CEILINGS.map((c, i) => (
              <div
                key={i}
                className="group flex h-full flex-1 flex-col items-center justify-end gap-2"
              >
                <span className="font-mono text-[10px] text-dim opacity-0 transition-opacity group-hover:opacity-100">
                  ≤ {fmt(c)}
                </span>
                <div
                  className="relative w-full overflow-hidden rounded-t-md border border-b-0 border-ember-500/30 bg-gradient-to-t from-ember-500/5 to-ember-500/25"
                  style={{ height: `${Math.max(3, (Math.sqrt(c) / Math.sqrt(max)) * 100)}%` }}
                >
                  {/* Where the jittered delay actually lands: anywhere in the bar. */}
                  <span
                    className="absolute inset-x-0 h-px bg-ember-300 shadow-[0_0_8px_rgb(255_141_88)]"
                    style={{ bottom: `${20 + ((i * 37) % 60)}%` }}
                  />
                </div>
                <span className="font-mono text-[10px] text-muted">#{i + 2}</span>
              </div>
            ))}
          </div>
          <figcaption className="mt-5 border-t border-ink-700/70 pt-4 text-xs leading-relaxed text-dim">
            Bar height = ceiling for each retry (square-root scale). Full jitter spreads retries
            across the whole bar, so a recovering receiver isn&apos;t hit by every client at once.
            Worst case for all 10 attempts: about 3 hours.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

const SECURITY = [
  [
    'Verified at the door',
    'HMAC-SHA256 or Standard Webhooks. A request that fails gets 401, is kept 24 h for debugging, and is never forwarded or replayed.',
  ],
  [
    'Signed on the way out',
    'Every delivery carries a Standard Webhooks signature with a per-destination secret that can be rotated.',
  ],
  [
    'SSRF guard',
    'Destinations are resolved once and pinned. Private, loopback and metadata addresses are refused, and redirects are never followed.',
  ],
  [
    'Secrets at rest',
    'Signing secrets are encrypted with AES-256-GCM, bound to their row, under a rotatable keyring. The API never returns them.',
  ],
  [
    'Sessions and keys',
    'Argon2id passwords, hashed session tokens in HttpOnly cookies, Origin checks, and hashed API keys for scripts.',
  ],
  [
    'Tenant isolation',
    "Every query is scoped to its owner. Another account's endpoint is a 404, never a 403.",
  ],
];

function Security() {
  return (
    <section id="security" className="mx-auto max-w-7xl scroll-mt-10 px-5 py-20 sm:px-8">
      <SectionTitle eyebrow="Security" title="Paranoid by default">
        Webhooks carry customer data and arrive from the open internet. RelayForge treats both sides
        as untrusted.
      </SectionTitle>
      <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-ink-700/80 bg-ink-700/80 sm:grid-cols-2 lg:grid-cols-3">
        {SECURITY.map(([t, b]) => (
          <div key={t} className="bg-ink-900 p-6 transition-colors hover:bg-ink-850">
            <p className="font-medium">{t}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">{b}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Developer() {
  return (
    <section className="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
      <div className="panel grid overflow-hidden lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-5 p-8 lg:p-10">
          <p className="eyebrow">For developers</p>
          <h2 className="text-3xl font-semibold tracking-tight">
            One URL in.{' '}
            <span className="font-display font-normal italic text-ember-300">Every attempt</span> on
            record.
          </h2>
          <p className="text-muted">
            Create an endpoint, point your provider at it, add a destination. From then on, every
            request is stored, forwarded and explained: what arrived, where it went, what came back.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link to="/signup" className={buttonClass('primary')}>
              Start free
            </Link>
            <a href={REPO} className={buttonClass('secondary')}>
              Source on GitHub
            </a>
          </div>
        </div>
        <div className="border-t border-ink-700 bg-ink-950/80 p-6 font-mono text-[12.5px] leading-6 lg:border-t-0 lg:border-l">
          <div className="mb-4 flex gap-1.5">
            <span className="size-2.5 rounded-full bg-ink-600" />
            <span className="size-2.5 rounded-full bg-ink-600" />
            <span className="size-2.5 rounded-full bg-ink-600" />
          </div>
          <pre className="overflow-x-auto whitespace-pre text-muted">
            <span className="text-dim"># a provider sends a webhook</span>
            {'\n'}
            <span className="text-ember-400">$</span> curl -X POST https://relay…/in/
            <span className="text-ice-300">&lt;slug&gt;</span> \{'\n'}
            {'    '}-H <span className="text-mint-300">&quot;x-github-delivery: 7f3a…&quot;</span>{' '}
            -d @push.json
            {'\n\n'}
            <span className="text-mint-400">HTTP/1.1 202 Accepted</span>
            {'\n'}
            {'{ '}
            <span className="text-ice-300">&quot;eventId&quot;</span>:{' '}
            <span className="text-amber-300">&quot;0193c1e2-…&quot;</span>
            {' }'}
            {'\n\n'}
            <span className="text-dim"># the same delivery id again: stored once, not re-sent</span>
            {'\n'}
            <span className="text-mint-400">HTTP/1.1 200 OK</span>
            {'\n'}
            {'{ '}
            <span className="text-ice-300">&quot;eventId&quot;</span>:{' '}
            <span className="text-amber-300">&quot;0193c1e2-…&quot;</span>,{' '}
            <span className="text-ice-300">&quot;duplicate&quot;</span>:{' '}
            <span className="text-ember-300">true</span>
            {' }'}
          </pre>
        </div>
      </div>
    </section>
  );
}

function SectionTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="max-w-2xl space-y-3">
      <p className="eyebrow text-ember-400">{eyebrow}</p>
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      <p className="text-muted">{children}</p>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="overflow-x-hidden">
      <Nav />
      <Hero />
      <Pipeline />
      <Reliability />
      <Security />
      <Developer />
      <footer className="border-t border-ink-700/60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-xs text-dim sm:px-8">
          <Wordmark />
          <p>Webhook relay and inspection · Node.js, Fastify and PostgreSQL</p>
          <div className="flex gap-5">
            <a href="/api/v1/docs" className="hover:text-fg">
              API
            </a>
            <a href={REPO} className="hover:text-fg">
              GitHub
            </a>
            <a href="/readyz" className="hover:text-fg">
              Status
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
