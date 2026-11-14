// The client IP (rate limits, stored source_ip) behind the host's load balancer (design §10).
// TRUST_PROXY = number of proxies in front of us; the client address is the X-Forwarded-For
// entry that the outermost trusted proxy appended — never one the client wrote itself.
import { describe, expect, test } from 'vitest';
import { createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';

async function sourceIpOf(trustProxy: number, forwardedFor: string | undefined) {
  const t = createTestApp({ TRUST_PROXY: trustProxy });
  try {
    const user = await signUp(t.app);
    const endpoint = await createEndpoint(t.app, user);
    const ingest = await t.app.inject({
      method: 'POST',
      url: `/in/${endpoint.slug}`,
      payload: '{}',
      remoteAddress: '10.0.0.7', // the load balancer
      headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    });
    const { eventId } = ingest.json<{ eventId: string }>();
    const event = await t.app.inject({
      url: `/api/v1/events/${eventId}`,
      headers: { cookie: user.cookie },
    });
    return event.json<{ event: { sourceIp: string } }>().event.sourceIp;
  } finally {
    await t.close();
  }
}

describe('TRUST_PROXY', () => {
  test('0 (default): X-Forwarded-For is ignored — the socket address is the client', async () => {
    expect(await sourceIpOf(0, '203.0.113.5')).toBe('10.0.0.7');
  });

  test('1: the address the proxy saw (rightmost X-Forwarded-For entry) is the client', async () => {
    expect(await sourceIpOf(1, '203.0.113.5')).toBe('203.0.113.5');
  });

  test('1: a client-forged entry on the left is not trusted', async () => {
    // The client sent "X-Forwarded-For: 1.2.3.4"; the proxy appended the real address.
    expect(await sourceIpOf(1, '1.2.3.4, 203.0.113.5')).toBe('203.0.113.5');
  });

  test('1 without the header: falls back to the socket address', async () => {
    expect(await sourceIpOf(1, undefined)).toBe('10.0.0.7');
  });
});
