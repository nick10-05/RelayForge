// Day 9 hardening through the real app: CSRF Origin check, security headers, rate limits,
// storage guard (design §7.3, §7.5).
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { events } from '../db/schema.ts';
import { createRateLimiter } from '../lib/token-bucket.ts';
import { createStorageGuard } from '../ops/storage-guard.ts';
import {
  TEST_ORIGIN,
  TEST_PASSWORD,
  createEndpoint,
  createTestApp,
  signUp,
} from '../testing/helpers.ts';
import { CSRF_REFUSED } from './csrf.ts';
import { RATE_LIMITED, createIngestCounters } from './limits.ts';

const tight = (capacity: number) => createRateLimiter({ capacity, refillPerSecond: 0.001 });

describe('CSRF Origin check', () => {
  const t = createTestApp({}, { noOrigin: true });
  const { app } = t;
  afterAll(() => t.close());

  const signupWith = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: `csrf-${Date.now()}-${Math.random()}@example.test`,
        password: TEST_PASSWORD,
      },
      headers,
    });

  test('state-changing API calls need an allowed Origin', async () => {
    expect((await signupWith({})).statusCode).toBe(403);
    expect((await signupWith({ origin: 'https://evil.example' })).json()).toEqual(CSRF_REFUSED);
    expect((await signupWith({ origin: 'null' })).statusCode).toBe(403);
    expect((await signupWith({ origin: 'http://localhost:3000.evil.example' })).statusCode).toBe(
      403,
    );
    expect((await signupWith({ origin: TEST_ORIGIN })).statusCode).toBe(201);
    expect((await signupWith({ origin: 'http://127.0.0.1:3000' })).statusCode).toBe(201);
  });

  test('a cookie-authenticated POST from another origin is refused; GET is not checked', async () => {
    const signup = await signupWith({ origin: TEST_ORIGIN });
    const cookie = signup.headers['set-cookie'] as string;
    const sessionCookie = cookie.split(';')[0]!;
    const create = (origin?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/endpoints',
        payload: { name: 'x' },
        headers: { cookie: sessionCookie, ...(origin && { origin }) },
      });
    expect((await create('https://evil.example')).statusCode).toBe(403);
    expect((await create()).statusCode).toBe(403);
    expect((await create(TEST_ORIGIN)).statusCode).toBe(201);
    const list = await app.inject({ url: '/api/v1/endpoints', headers: { cookie: sessionCookie } });
    expect(list.statusCode).toBe(200);
  });

  test('API-key requests and ingest are not Origin-checked', async () => {
    const signup = await signupWith({ origin: TEST_ORIGIN });
    const sessionCookie = (signup.headers['set-cookie'] as string).split(';')[0]!;
    const key = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        payload: { name: 'ci' },
        headers: { cookie: sessionCookie, origin: TEST_ORIGIN },
      })
    ).json<{ key: string }>().key;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/endpoints',
      payload: { name: 'from-ci' },
      headers: { authorization: `Bearer ${key}` }, // no Origin, like curl
    });
    expect(created.statusCode).toBe(201);
    const { slug } = created.json<{ endpoint: { slug: string } }>().endpoint;
    const ingest = await app.inject({ method: 'POST', url: `/in/${slug}`, payload: '{}' });
    expect(ingest.statusCode).toBe(202);
  });

  test('APP_ORIGIN replaces the dev defaults', async () => {
    const prodLike = createTestApp({ APP_ORIGIN: 'https://relay.example' }, { noOrigin: true });
    try {
      const ok = await prodLike.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: 'https://relay.example' },
      });
      expect(ok.statusCode).toBe(204);
      const dev = await prodLike.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { origin: TEST_ORIGIN },
      });
      expect(dev.statusCode).toBe(403);
    } finally {
      await prodLike.close();
    }
  });
});

describe('security headers (helmet)', () => {
  const t = createTestApp();
  afterAll(() => t.close());

  test('CSP, nosniff, frame protection and HSTS are set', async () => {
    const response = await t.app.inject({ url: '/healthz' });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toContain('max-age=');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rate limits', () => {
  test('ingest: per-endpoint bucket → 429 + Retry-After; other endpoints unaffected', async () => {
    const t = createTestApp({}, { limits: { ingest: tight(3) } });
    try {
      const user = await signUp(t.app);
      const a = await createEndpoint(t.app, user, { name: 'a' });
      const b = await createEndpoint(t.app, user, { name: 'b' });
      const send = (slug: string) =>
        t.app.inject({ method: 'POST', url: `/in/${slug}`, payload: '{}' });
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await send(a.slug)).statusCode);
      expect(codes).toEqual([202, 202, 202, 429]);
      const limited = await send(a.slug);
      expect(limited.json()).toEqual(RATE_LIMITED);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await send(b.slug)).statusCode).toBe(202);
      const stored = await t.db.select().from(events).where(eq(events.endpointId, a.id));
      expect(stored).toHaveLength(3); // limited requests are not stored
    } finally {
      await t.close();
    }
  });

  test('invalid signatures: stricter bucket; over it → same 401, not stored, only counted', async () => {
    const counters = createIngestCounters();
    const t = createTestApp({}, { limits: { invalidSignature: tight(2) }, counters });
    try {
      const user = await signUp(t.app);
      const secret = 'hmac-secret';
      const endpoint = await createEndpoint(t.app, user, {
        name: 'gh',
        verification: { scheme: 'hmac', header: 'x-sig', encoding: 'hex', secret },
      });
      const forged = () =>
        t.app.inject({
          method: 'POST',
          url: `/in/${endpoint.slug}`,
          payload: '{}',
          headers: { 'x-sig': '00' },
        });
      const responses = [await forged(), await forged(), await forged(), await forged()];
      expect(responses.map((r) => r.statusCode)).toEqual([401, 401, 401, 401]);
      expect(new Set(responses.map((r) => r.body)).size).toBe(1);

      const invalid = await t.db
        .select()
        .from(events)
        .where(and(eq(events.endpointId, endpoint.id), eq(events.signatureStatus, 'invalid')));
      expect(invalid).toHaveLength(2);
      expect(counters.invalidSignatureDropped.get(endpoint.id)).toBe(2);

      // Valid traffic still flows: the invalid budget is separate.
      const body = '{"ok":true}';
      const valid = await t.app.inject({
        method: 'POST',
        url: `/in/${endpoint.slug}`,
        payload: body,
        headers: { 'x-sig': createHmac('sha256', secret).update(body).digest('hex') },
      });
      expect(valid.statusCode).toBe(202);
    } finally {
      await t.close();
    }
  });

  test('login: per-IP and per-email limits → 429 before the password is checked', async () => {
    const t = createTestApp({}, { limits: { authIp: tight(100), loginEmail: tight(3) } });
    try {
      const user = await signUp(t.app);
      const login = (email: string, password = 'wrong-password-123') =>
        t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await login(user.email)).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
      // Even the right password is refused while the email's bucket is empty.
      expect((await login(user.email, TEST_PASSWORD)).statusCode).toBe(429);
      // Other emails are unaffected; an unknown email gets the same limit (no enumeration).
      expect((await login('nobody@example.test')).statusCode).toBe(401);
    } finally {
      await t.close();
    }

    const ipLimited = createTestApp({}, { limits: { authIp: tight(2) } });
    try {
      const codes = [];
      for (let i = 0; i < 3; i++) {
        const r = await ipLimited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: `x${i}@example.test`, password: 'whatever-123' },
        });
        codes.push(r.statusCode);
      }
      expect(codes).toEqual([401, 401, 429]);
    } finally {
      await ipLimited.close();
    }
  });
});

describe('storage guard', () => {
  test('ingest answers 503 + Retry-After while the database is nearly full; nothing stored', async () => {
    let full = true;
    const t = createTestApp({}, { storageGuard: { blocked: () => full } });
    try {
      const user = await signUp(t.app);
      const endpoint = await createEndpoint(t.app, user);
      const send = () =>
        t.app.inject({ method: 'POST', url: `/in/${endpoint.slug}`, payload: '{}' });
      const refused = await send();
      expect(refused.statusCode).toBe(503);
      expect(refused.headers['retry-after']).toBe('600');
      expect(
        await t.db.select().from(events).where(eq(events.endpointId, endpoint.id)),
      ).toHaveLength(0);
      full = false;
      expect((await send()).statusCode).toBe(202);
    } finally {
      await t.close();
    }
  });

  test('threshold 90 %, lazy hourly refresh, failures keep the last state', async () => {
    let size = 0;
    let fail = false;
    let queries = 0;
    let now = 0;
    const pool = {
      query: () => {
        queries++;
        if (fail) return Promise.reject(new Error('db down'));
        return Promise.resolve({ rows: [{ size: String(size) }] });
      },
    } as unknown as Parameters<typeof createStorageGuard>[0]['pool'];
    const guard = createStorageGuard({ pool, capBytes: 1000, now: () => now });

    size = 899;
    await guard.refresh();
    expect(guard.blocked()).toBe(false);
    size = 900;
    expect(guard.blocked()).toBe(false); // not re-measured yet (cached for an hour)
    expect(queries).toBe(1);

    now += 60 * 60 * 1000;
    guard.blocked(); // stale → refresh starts in the background
    await guard.refresh(); // (joins the in-flight refresh)
    expect(queries).toBe(2);
    expect(guard.blocked()).toBe(true);

    fail = true;
    now += 60 * 60 * 1000;
    await guard.refresh();
    expect(guard.blocked()).toBe(true); // last known state kept
    expect(guard.lastSizeBytes).toBe(900);
  });
});
