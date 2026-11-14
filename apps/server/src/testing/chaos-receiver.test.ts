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
