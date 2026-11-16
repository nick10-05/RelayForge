// A scripted, ~15-second walkthrough of the delivery engine for demos and interviews.
//
//   1. npm run db:up
//   2. Set ALLOW_PRIVATE_DESTINATIONS=true in .env (destinations point at 127.0.0.1), then npm run dev
//   3. npm run demo                      (or BASE_URL=http://127.0.0.1:3100 npm run demo)
//
// It talks to the REAL running server over HTTP, exactly like a provider and a user would, and
// starts its own chaos receiver as the destinations. It creates a throwaway account, so it
// refuses to run against anything but a loopback address.
//
// Scenes: fan-out + retry classification (incl. Retry-After) · signatures checked at the
// receiver · inbound dedupe · double-click-safe retry · forged signature stored, never forwarded.
import { createHmac, randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { startChaosReceiver } from './chaos-receiver.ts';

const BASE = (process.env['BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const host = new URL(BASE).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
  console.error(
    `Refusing to run against ${BASE}: the demo creates an account. Use a local server.`,
  );
  process.exit(1);
}

type Attempt = { attemptNo: number; statusCode: number | null; errorCode: string | null };
type Delivery = {
  id: string;
  destinationUrl: string;
  status: string;
  deadReason: string | null;
  trigger: string;
  attempts: Attempt[];
};
type EventDetail = { id: string; signatureStatus: string; deliveries: Delivery[] };

let cookie = '';
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE, // state-changing calls must come from an allowed origin (CSRF check)
      ...(cookie && { cookie }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.getSetCookie()[0];
  if (setCookie) cookie = setCookie.split(';')[0]!;
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as unknown };
}
async function must<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, json } = await api(method, path, body);
  if (status >= 300) throw new Error(`${method} ${path} → ${status} ${JSON.stringify(json)}`);
  return json as T;
}
const ingest = (slug: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}/in/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text = '') => console.log(text);
const scene = (n: number, title: string) =>
  say(`\n━━ ${n}. ${title} ${'━'.repeat(60 - title.length)}`);
const timeline = (d: Delivery) =>
  d.attempts.map((a) => a.statusCode ?? a.errorCode ?? '?').join(' → ') || '(no attempts yet)';

async function waitForTerminal(eventId: string, expected: number, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const { event } = await must<{ event: EventDetail }>('GET', `/api/v1/events/${eventId}`);
    const done = event.deliveries.filter((d) => d.status === 'succeeded' || d.status === 'dead');
    if (event.deliveries.length >= expected && done.length === event.deliveries.length)
      return event;
    if (Date.now() - start > timeoutMs) throw new Error('deliveries did not finish in time');
    await sleep(250);
  }
}

// ── setup ────────────────────────────────────────────────────────────────────────────────────
try {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(String(health.status));
} catch {
  console.error(`No RelayForge server at ${BASE}. Start it with: npm run dev`);
  process.exit(1);
}
const chaos = await startChaosReceiver(0);
const email = `demo-${Date.now()}@example.test`;
const password = randomUUID();

try {
  await must('POST', '/api/v1/auth/signup', { email, password });

  // ── 1. fan-out and retry classification ──────────────────────────────────────────────────
  scene(1, 'One event, five destinations, five different receivers');
  const { endpoint } = await must<{ endpoint: { id: string; slug: string } }>(
    'POST',
    '/api/v1/endpoints',
    { name: 'Demo: payments', dedupeSource: 'header', dedupeName: 'x-demo-id' },
  );
  const receivers: [path: string, label: string, maxAttempts?: number][] = [
    ['/ok', 'healthy receiver'],
    ['/busy/2', 'rate-limited twice (429 + Retry-After: 1)'],
    ['/status/404', 'wrong URL (404)'],
    ['/redirect', 'redirects (302)'],
    ['/retry-after/1', 'always 429, max 3 attempts', 3],
  ];
  const labels = new Map<string, string>();
  for (const [path, label, maxAttempts] of receivers) {
    const url = `${chaos.url}${path}`;
    const created = await api('POST', `/api/v1/endpoints/${endpoint.id}/destinations`, {
      url,
      ...(maxAttempts && { maxAttempts }),
    });
    if (created.status !== 201) {
      throw new Error(
        `destination ${url} → ${created.status} ${JSON.stringify(created.json)}\n` +
          'Hint: set ALLOW_PRIVATE_DESTINATIONS=true in .env and restart the server.',
      );
    }
    labels.set(url, label);
  }

  const body = JSON.stringify({ type: 'payment.succeeded', data: { id: 'pay_42', amount: 4200 } });
  const sent = await ingest(endpoint.slug, body, { 'x-demo-id': 'pay_42' });
  say(
    `POST /in/<slug> → ${sent.status} ${JSON.stringify(sent.json)}   (acknowledged after commit)`,
  );
  const eventId = String(sent.json['eventId']);

  const event = await waitForTerminal(eventId, receivers.length);
  say();
  for (const d of event.deliveries) {
    const outcome = d.status === 'dead' ? `dead (${d.deadReason})` : d.status;
    say(`  ${labels.get(d.destinationUrl)!.padEnd(44)} ${timeline(d).padEnd(18)} ${outcome}`);
  }
  say('\n  2xx = done · 408/429/5xx/network = retry with backoff (Retry-After honoured)');
  say('  other 4xx = dead at once · 3xx = dead (redirects are never followed)');

  // ── signatures and stable ids, checked where the receiver sees them ────────────────────────
  const okDest = event.deliveries.find((d) => d.destinationUrl.endsWith('/busy/2'))!;
  const { destinations } = await must<{ destinations: { id: string; url: string }[] }>(
    'GET',
    `/api/v1/endpoints/${endpoint.id}/destinations`,
  );
  const destId = destinations.find((d) => d.url === okDest.destinationUrl)!.id;
  const { signingSecret } = await must<{ signingSecret: string }>(
    'GET',
    `/api/v1/endpoints/${endpoint.id}/destinations/${destId}/secret`,
  );
  const busyRequests = chaos.requestsTo('/busy/2');
  const verified = busyRequests.every((r) => {
    try {
      new Webhook(signingSecret).verify(r.body, {
        'webhook-id': String(r.headers['x-relayforge-id']),
        'webhook-timestamp': String(r.headers['x-relayforge-timestamp']),
        'webhook-signature': String(r.headers['x-relayforge-signature']),
      });
      return true;
    } catch {
      return false;
    }
  });
  const ids = new Set(chaos.requests.map((r) => r.headers['x-relayforge-id']));
  say(
    `\n  The receiver got ${chaos.requests.length} requests. All carry X-RelayForge-Id = ${[...ids].join(', ')}` +
      `\n  (the event id: one dedupe key across retries and fan-out → at-least-once, dedupe on it).`,
  );
  say(
    `  ${busyRequests.length} attempts to the rate-limited receiver: signatures verified with the` +
      ` Standard Webhooks library: ${verified ? 'all valid ✓' : 'FAILED ✗'}` +
      ` (each attempt is signed with a fresh timestamp).`,
  );

  // ── 2. inbound dedupe ─────────────────────────────────────────────────────────────────────
  scene(2, 'The provider retries the same event (same X-Demo-Id)');
  const before = chaos.requests.length;
  const dup = await ingest(endpoint.slug, body, { 'x-demo-id': 'pay_42' });
  await sleep(1000);
  say(`POST /in/<slug> → ${dup.status} ${JSON.stringify(dup.json)}`);
  say(
    `  Same event id, counted as a duplicate; new outbound requests: ${chaos.requests.length - before}`,
  );

  // ── 3. double-click-safe retry ────────────────────────────────────────────────────────────
  scene(3, 'Someone double-clicks "Retry" on the dead 404 delivery');
  const dead404 = event.deliveries.find((d) => d.destinationUrl.endsWith('/status/404'))!;
  const clicks = await Promise.all([
    api('POST', `/api/v1/deliveries/${dead404.id}/retry`),
    api('POST', `/api/v1/deliveries/${dead404.id}/retry`),
  ]);
  // Let the manual retry finish while the receiver is still up (else it would keep retrying).
  await waitForTerminal(eventId, receivers.length + 1);
  say(`  Two concurrent retries → ${clicks.map((c) => c.status).join(' and ')}`);
  say('  A partial unique index allows one active delivery per (event, destination): the second');
  say('  click gets 409 with the existing delivery id instead of sending a duplicate.');

  // ── 4. forged signature ───────────────────────────────────────────────────────────────────
  scene(4, 'An endpoint that verifies signatures receives a forgery');
  const secret = `demo-${randomUUID()}`;
  const { endpoint: verifiedEp } = await must<{ endpoint: { id: string; slug: string } }>(
    'POST',
    '/api/v1/endpoints',
    {
      name: 'Demo: verified',
      verification: { scheme: 'hmac', header: 'x-signature', encoding: 'hex', secret },
    },
  );
  // Its own receiver path, so only this endpoint's traffic is counted below.
  await must('POST', `/api/v1/endpoints/${verifiedEp.id}/destinations`, {
    url: `${chaos.url}/ok/verified`,
  });
  const forged = await ingest(verifiedEp.slug, '{"refund":"all of it"}', { 'x-signature': 'f00d' });
  const realBody = '{"refund":"pay_42"}';
  const real = await ingest(verifiedEp.slug, realBody, {
    'x-signature': createHmac('sha256', secret).update(realBody).digest('hex'),
  });
  await waitForTerminal(String(real.json['eventId']), 1);
  const { events: list } = await must<{ events: { id: string; signatureStatus: string }[] }>(
    'GET',
    `/api/v1/endpoints/${verifiedEp.id}/events`,
  );
  const invalid = list.find((e) => e.signatureStatus === 'invalid')!;
  const replay = await api('POST', `/api/v1/events/${invalid.id}/replay`);
  say(`  Forged → ${forged.status}; correctly signed → ${real.status}`);
  say(`  Stored events: ${list.map((e) => e.signatureStatus).join(', ')}`);
  say(
    `  Outbound requests caused: ${chaos.requestsTo('/ok/verified').length} (only the valid one)`,
  );
  say(`  Replaying the forgery → ${replay.status} (invalid events can never be forwarded)`);

  // ── wrap-up ───────────────────────────────────────────────────────────────────────────────
  say(`\n━━ See it in the dashboard ${'━'.repeat(37)}`);
  say(`  ${BASE}/login   ${email} / ${password}   (throwaway local account)`);
  say(`  ${BASE}/events/${eventId}   (attempt timeline for scene 1)`);
} finally {
  await chaos.close();
}
