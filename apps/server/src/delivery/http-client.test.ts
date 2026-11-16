// Outbound HTTP against the local chaos receiver (no network beyond 127.0.0.1).
import { createServer as createHttpServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startChaosReceiver } from '../testing/chaos-receiver.ts';
import type { ChaosReceiver } from '../testing/chaos-receiver.ts';
import { fakeResolve } from '../testing/fake-dns.ts';
import { MAX_RESPONSE_BYTES, buildForwardHeaders, createHttpSender } from './http-client.ts';
import { testSecretBox } from '../testing/test-keys.ts';
import { generateSigningSecret } from './signing.ts';
import type { ClaimedDelivery } from './types.ts';

const REF = { table: 'destinations', column: 'signing_secret_enc', rowId: 'dst-1' };

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
    signingSecrets: [],
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

describe('signed deliveries', () => {
  let chaos: ChaosReceiver;
  beforeAll(async () => {
    chaos = await startChaosReceiver();
  });
  afterAll(() => chaos.close());

  test('signs with current + previous secret; the reference library verifies', async () => {
    const current = generateSigningSecret();
    const previous = generateSigningSecret();
    const send = createHttpSender({
      production: false,
      allowPrivate: true,
      secretBox: testSecretBox,
    });
    const result = await send(
      makeClaim(`${chaos.url}/ok`, {
        signingSecrets: [
          { column: 'signing_secret_enc', sealed: testSecretBox.seal(current, REF) },
          {
            column: 'prev_signing_secret_enc',
            sealed: testSecretBox.seal(previous, { ...REF, column: 'prev_signing_secret_enc' }),
          },
        ],
      }),
    );
    expect(result.statusCode).toBe(200);
    const req = chaos.requests.at(-1)!;
    const signature = req.headers['x-relayforge-signature'] as string;
    expect(signature.split(' ')).toHaveLength(2);
    for (const secret of [current, previous]) {
      expect(() =>
        new Webhook(secret).verify(req.body, {
          'webhook-id': req.headers['x-relayforge-id'] as string,
          'webhook-timestamp': req.headers['x-relayforge-timestamp'] as string,
          'webhook-signature': signature,
        }),
      ).not.toThrow();
    }
  });

  test('the timestamp is taken per attempt', async () => {
    let clock = 1_800_000_000_000;
    const send = createHttpSender({
      production: false,
      allowPrivate: true,
      secretBox: testSecretBox,
      now: () => clock,
    });
    const claim = makeClaim(`${chaos.url}/ok`, {
      signingSecrets: [
        { column: 'signing_secret_enc', sealed: testSecretBox.seal(generateSigningSecret(), REF) },
      ],
    });
    await send(claim);
    clock += 3_600_000;
    await send({ ...claim, attemptCount: 3 });
    const stamps = chaos.requests.slice(-2).map((r) => r.headers['x-relayforge-timestamp']);
    expect(stamps).toEqual(['1800000000', '1800003600']);
  });

  test('no secret → no signature headers', async () => {
    const send = createHttpSender({ production: false, allowPrivate: true });
    await send(makeClaim(`${chaos.url}/ok`));
    const req = chaos.requests.at(-1)!;
    expect(req.headers['x-relayforge-signature']).toBeUndefined();
    expect(req.headers['x-relayforge-timestamp']).toBeUndefined();
  });

  test('a secret sealed for another row (AAD mismatch) is never sent unsigned', async () => {
    const send = createHttpSender({
      production: false,
      allowPrivate: true,
      secretBox: testSecretBox,
    });
    const before = chaos.requests.length;
    const sealedElsewhere = testSecretBox.seal(generateSigningSecret(), { ...REF, rowId: 'dst-2' });
    const result = await send(
      makeClaim(`${chaos.url}/ok`, {
        signingSecrets: [{ column: 'signing_secret_enc', sealed: sealedElsewhere }],
      }),
    );
    expect(result.errorCode).toBe('SIGNING_FAILED');
    expect(chaos.requests).toHaveLength(before);
  });

  test('an unopenable secret is never sent unsigned and never echoed', async () => {
    const send = createHttpSender({ production: false, allowPrivate: true });
    const before = chaos.requests.length;
    const result = await send(
      makeClaim(`${chaos.url}/ok`, {
        signingSecrets: [{ column: 'signing_secret_enc', sealed: 'garbage-whsec_abc' }],
      }),
    );
    expect(result.errorCode).toBe('SIGNING_FAILED');
    expect(result.errorMessage).not.toContain('garbage');
    expect(chaos.requests).toHaveLength(before);
  });
});

describe('misbehaving receivers (own server per test)', () => {
  const send = createHttpSender({ production: false, allowPrivate: true, resolve: fakeResolve });

  /** Runs `handler` on a throwaway HTTP server for one request. */
  async function withServer<T>(handler: RequestListener, run: (url: string) => Promise<T>) {
    const server = createHttpServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  test('headers arrive but the body never ends → the status counts, not a TIMEOUT', async () => {
    const result = await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('partial'); // ...and never res.end()
      },
      (url) => send(makeClaim(url, { timeoutMs: 300 })),
    );
    expect(result).toMatchObject({ statusCode: 200, responseBodySnippet: 'partial' });
    expect(result.errorCode).toBeUndefined();
  });

  test('response headers are capped: at most 50, each value at most 512 chars', async () => {
    const result = await withServer(
      (_req, res) => {
        // Within Node's 16 KB header limit: long values first so they survive the count cap.
        res.setHeader('x-long', 'v'.repeat(2000));
        res.setHeader('set-cookie', ['a'.repeat(2000), 'b']); // the one header Node keeps as an array
        for (let i = 0; i < 80; i++) res.setHeader(`x-h${i}`, String(i));
        res.end('ok');
      },
      (url) => send(makeClaim(url)),
    );
    const headers = result.responseHeaders!;
    expect(Object.keys(headers)).toHaveLength(50);
    expect(headers['x-long']).toHaveLength(512);
    expect(headers['set-cookie']).toEqual(['a'.repeat(512), 'b']);
  });

  test('a header block over 16 KB is refused as an error (retryable), not buffered', async () => {
    const result = await withServer(
      (_req, res) => {
        for (let i = 0; i < 20; i++) res.setHeader(`x-h${i}`, 'v'.repeat(2000));
        res.end('ok');
      },
      (url) => send(makeClaim(url)),
    );
    expect(result.statusCode).toBeUndefined();
    expect(result.errorCode).toBe('HPE_HEADER_OVERFLOW');
  });
});
