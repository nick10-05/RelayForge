// Outbound HTTP against the local chaos receiver (no network beyond 127.0.0.1).
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startChaosReceiver } from '../testing/chaos-receiver.ts';
import type { ChaosReceiver } from '../testing/chaos-receiver.ts';
import { fakeResolve } from '../testing/fake-dns.ts';
import { MAX_RESPONSE_BYTES, buildForwardHeaders, createHttpSender } from './http-client.ts';
import type { ClaimedDelivery } from './types.ts';

function makeClaim(url: string, extra: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    id: 'dlv-1',
    eventId: 'evt-1',
    endpointId: 'ep-1',
    destinationId: 'dst-1',
    attemptCount: 2,
    maxAttempts: 10,
    trigger: 'auto',
    leaseOwner: 'w',
    leaseExpiresAt: new Date(),
    url,
    timeoutMs: 2000,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"hello":"world"}'),
    contentType: 'application/json',
    ...extra,
  };
}

describe('buildForwardHeaders', () => {
  test('strips hop-by-hop, cookies, proxy and spoofed relayforge headers', () => {
    const headers = buildForwardHeaders(
      makeClaim('http://x', {
        headers: {
          Host: 'evil',
          Connection: 'keep-alive',
          'Transfer-Encoding': 'chunked',
          'Content-Length': '999',
          Cookie: 'a=b',
          'Proxy-Authorization': 'x',
          Expect: '100-continue',
          'X-RelayForge-Id': 'spoofed',
          'X-Signature': 'sig',
          'Content-Type': 'application/json',
        },
      }),
    );
    expect(headers).toEqual({
      'x-signature': 'sig',
      'content-type': 'application/json',
      'content-length': '17',
      'x-relayforge-id': 'evt-1',
      'x-relayforge-delivery-id': 'dlv-1',
      'x-relayforge-attempt': '2',
    });
  });

  test('manual replays are marked', () => {
    expect(buildForwardHeaders(makeClaim('http://x', { trigger: 'manual' }))).toMatchObject({
      'x-relayforge-replay': 'true',
    });
  });
});

describe('createHttpSender', () => {
  let chaos: ChaosReceiver;
  let port: string;
  const send = createHttpSender({ production: false, allowPrivate: true, resolve: fakeResolve });
  const strict = createHttpSender({ production: false, allowPrivate: false, resolve: fakeResolve });

  beforeAll(async () => {
    chaos = await startChaosReceiver();
    port = new URL(chaos.url).port;
  });
  beforeEach(() => chaos.reset());
  afterAll(() => chaos.close());

  test('forwards method, body and headers; records status and snippet', async () => {
    const result = await send(makeClaim(`${chaos.url}/ok?x=1`));
    expect(result).toMatchObject({ statusCode: 200, responseBodySnippet: 'chaos:200' });
    expect(result.durationMs).toBeGreaterThan(0);
    const [req] = chaos.requests;
    expect(req).toMatchObject({ method: 'POST', path: '/ok' });
    expect(req!.body.toString()).toBe('{"hello":"world"}');
    expect(req!.headers).toMatchObject({
      'content-type': 'application/json',
      'x-relayforge-id': 'evt-1',
      'x-relayforge-delivery-id': 'dlv-1',
      'x-relayforge-attempt': '2',
    });
  });

  test('response body is capped at 4 KB', async () => {
    const result = await send(makeClaim(`${chaos.url}/big/100000`));
    expect(result.statusCode).toBe(200);
    expect(result.responseBodySnippet).toHaveLength(MAX_RESPONSE_BYTES);
  });

  test('redirects are not followed', async () => {
    const result = await send(makeClaim(`${chaos.url}/redirect`));
    expect(result.statusCode).toBe(302);
    expect(chaos.requestsTo('/ok')).toHaveLength(0);
  });

  test('Retry-After is captured in response headers', async () => {
    const result = await send(makeClaim(`${chaos.url}/retry-after/7`));
    expect(result).toMatchObject({ statusCode: 429, responseHeaders: { 'retry-after': '7' } });
  });

  test('a hung receiver → TIMEOUT after timeoutMs', async () => {
    const result = await send(makeClaim(`${chaos.url}/hang`, { timeoutMs: 200 }));
    expect(result.errorCode).toBe('TIMEOUT');
    expect(result.statusCode).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(190);
    expect(result.durationMs).toBeLessThan(1500);
  });

  test('a reset connection → ECONNRESET', async () => {
    const result = await send(makeClaim(`${chaos.url}/reset`));
    expect(result.errorCode).toBe('ECONNRESET');
  });

  test('nothing listening → ECONNREFUSED', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const freePort = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const result = await send(makeClaim(`http://127.0.0.1:${freePort}/x`));
    expect(result.errorCode).toBe('ECONNREFUSED');
  });

  test.each([
    ['IPv4 loopback', `http://127.0.0.1:PORT/ok`],
    ['IPv6 loopback', `http://[::1]:PORT/ok`],
    ['decimal IPv4', `http://2130706433:PORT/ok`],
    ['metadata IP', `http://169.254.169.254:8080/latest`],
    ['private hostname', `http://db.internal:PORT/ok`],
    ['localhost', `http://localhost:PORT/ok`],
    ['DNS rebinding answer', `http://rebind.example:PORT/ok`],
  ])('blocks %s without sending', async (_case, template) => {
    const result = await strict(makeClaim(template.replace('PORT', port)));
    expect(result.errorCode).toBe('SSRF_BLOCKED');
    expect(chaos.requests).toHaveLength(0);
  });

  test('connects to the vetted address, keeps the original Host header', async () => {
    const result = await send(makeClaim(`http://hooks.chaos.test:${port}/ok`));
    expect(result.statusCode).toBe(200);
    expect(chaos.requests[0]!.headers.host).toBe(`hooks.chaos.test:${port}`);
  });

  test('production refuses plain http before connecting', async () => {
    const prod = createHttpSender({ production: true, allowPrivate: false, resolve: fakeResolve });
    const result = await prod(makeClaim(`http://example.com:${port}/ok`));
    expect(result.errorCode).toBe('SSRF_BLOCKED');
  });

  test('unresolvable host → ENOTFOUND (retryable)', async () => {
    const result = await strict(makeClaim(`http://nxdomain.example:${port}/ok`));
    expect(result.errorCode).toBe('ENOTFOUND');
  });
});
