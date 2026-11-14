import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { startChaosReceiver } from './chaos-receiver.ts';
import type { ChaosReceiver } from './chaos-receiver.ts';

describe('chaos receiver', () => {
  let chaos: ChaosReceiver;
  const ready = startChaosReceiver().then((c) => (chaos = c));
  beforeEach(async () => {
    await ready;
    chaos.reset();
  });
  afterAll(async () => (await ready).close());

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${chaos.url}${path}`, { method: 'POST', body: 'payload', headers, redirect: 'manual' });

  test('records requests', async () => {
    await post('/ok', { 'x-test': '1' });
    expect(chaos.requests).toHaveLength(1);
    expect(chaos.requests[0]).toMatchObject({ method: 'POST', path: '/ok' });
    expect(chaos.requests[0]?.body.toString()).toBe('payload');
  });

  test('status, retry-after and redirect modes', async () => {
    expect((await post('/status/503')).status).toBe(503);
    const limited = await post('/retry-after/7');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('7');
    const redirect = await post('/redirect');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/ok');
  });

  test('flaky fails n times per delivery id, then succeeds', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await post('/flaky/2', { 'x-relayforge-delivery-id': 'd1' })).status);
    }
    expect(statuses).toEqual([500, 500, 200, 200]);
    expect((await post('/flaky/2', { 'x-relayforge-delivery-id': 'd2' })).status).toBe(500);
  });

  test('reset destroys the connection; hang never answers', async () => {
    await expect(post('/reset')).rejects.toThrow();
    await expect(
      fetch(`${chaos.url}/hang`, { method: 'POST', signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
  });
});

// Limits for running the receiver publicly (the demo service): bounded memory and sockets.
describe('chaos receiver — public mode limits', () => {
  test('request bodies over the cap get 413 and are not stored', async () => {
    const chaos = await startChaosReceiver(0, { maxBodyBytes: 1024 });
    try {
      const small = await fetch(`${chaos.url}/ok`, { method: 'POST', body: 'x'.repeat(1024) });
      expect(small.status).toBe(200);
      const big = await fetch(`${chaos.url}/ok`, { method: 'POST', body: 'x'.repeat(1025) });
      expect(big.status).toBe(413);
      expect(chaos.requests).toHaveLength(1);
    } finally {
      await chaos.close();
    }
  });

  test('keeps only the most recent maxRequests requests', async () => {
    const chaos = await startChaosReceiver(0, { maxRequests: 3 });
    try {
      for (let i = 0; i < 5; i++) await fetch(`${chaos.url}/ok?n=${i}`, { method: 'POST' });
      expect(chaos.requests).toHaveLength(3);
      expect(chaos.total()).toBe(5);
    } finally {
      await chaos.close();
    }
  });

  test('/hang gives up after hangMs instead of holding the socket forever', async () => {
    const chaos = await startChaosReceiver(0, { hangMs: 100 });
    try {
      const started = Date.now();
      const response = await fetch(`${chaos.url}/hang`, { method: 'POST' });
      expect(response.status).toBe(504);
      expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    } finally {
      await chaos.close();
    }
  });
});
