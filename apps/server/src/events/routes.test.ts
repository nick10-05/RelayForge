import { afterAll, describe, expect, test } from 'vitest';
import { createDestination, createEndpoint, createTestApp, signUp } from '../testing/helpers.ts';
import type { TestUser } from '../testing/helpers.ts';
import { decodeCursor, encodeCursor } from './routes.ts';

type Summary = { id: string; method: string; sizeBytes: number; receivedAt: string };
type Page = { events: Summary[]; nextCursor: string | null };

describe('events API', () => {
  const t = createTestApp();
  const { app } = t;
  afterAll(() => t.close());

  const get = (user: TestUser, url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: user.cookie } });

  const ingest = async (slug: string, body: string | Buffer, contentType = 'application/json') => {
    const response = await app.inject({
      method: 'POST',
      url: `/in/${slug}`,
      payload: body,
      headers: { 'content-type': contentType },
    });
    return response.json<{ eventId: string }>().eventId;
  };

  test('list is newest first and keyset-paginates without gaps or repeats', async () => {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await ingest(endpoint.slug, `{"n":${i}}`));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : '';
      const response = await get(user, `/api/v1/endpoints/${endpoint.id}/events?limit=3${query}`);
      expect(response.statusCode).toBe(200);
      const page = response.json<Page>();
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
  });

  test('list validates limit and cursor', async () => {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user);
    const base = `/api/v1/endpoints/${endpoint.id}/events`;
    expect((await get(user, `${base}?limit=0`)).statusCode).toBe(400);
    expect((await get(user, `${base}?limit=101`)).statusCode).toBe(400);
    expect((await get(user, `${base}?cursor=garbage`)).statusCode).toBe(400);
  });

  test('cursor encode/decode round-trips and rejects junk', () => {
    const cursor = {
      receivedAt: new Date('2026-11-14T10:00:00.123Z'),
      id: '01960000-0000-7000-8000-000000000000',
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(Buffer.from('not-a-date|x').toString('base64url'))).toBeNull();
    expect(
      decodeCursor(Buffer.from('2026-11-14T10:00:00Z|not-a-uuid').toString('base64url')),
    ).toBeNull();
  });

  test('detail shows headers, text body and deliveries', async () => {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user);
    const destination = await createDestination(app, user, endpoint.id);
    const id = await ingest(endpoint.slug, '{"hello":"wörld"}');

    const response = await get(user, `/api/v1/events/${id}`);
    expect(response.statusCode).toBe(200);
    const { event } = response.json<{ event: Record<string, unknown> }>();
    expect(event).toMatchObject({
      id,
      method: 'POST',
      body: { encoding: 'utf8', data: '{"hello":"wörld"}' },
      bodyTruncated: false,
      signatureStatus: 'not_checked',
      deliveries: [{ destinationId: destination.id, status: 'pending', attemptCount: 0 }],
    });
    expect((event['headers'] as Record<string, string>)['content-type']).toBe('application/json');
  });

  test('binary bodies are base64 in detail and exact via the raw body download', async () => {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user);
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const id = await ingest(endpoint.slug, bytes, 'application/octet-stream');

    const detail = (await get(user, `/api/v1/events/${id}`)).json<{ event: { body: object } }>();
    expect(detail.event.body).toEqual({ encoding: 'base64', data: bytes.toString('base64') });

    const raw = await get(user, `/api/v1/events/${id}/body`);
    expect(raw.statusCode).toBe(200);
    expect(raw.rawPayload.equals(bytes)).toBe(true);
  });

  test('raw body is never served with the sender content type (no stored XSS)', async () => {
    const user = await signUp(app);
    const endpoint = await createEndpoint(app, user);
    const id = await ingest(endpoint.slug, '<script>alert(1)</script>', 'text/html');
    const raw = await get(user, `/api/v1/events/${id}/body`);
    expect(raw.headers['content-type']).toBe('application/octet-stream');
    expect(raw.headers['x-content-type-options']).toBe('nosniff');
    expect(raw.headers['content-disposition']).toMatch(/^attachment;/);
  });

  test('tenant isolation: another user gets 404 for list, detail and body', async () => {
    const owner = await signUp(app);
    const intruder = await signUp(app);
    const endpoint = await createEndpoint(app, owner);
    const id = await ingest(endpoint.slug, '{}');

    expect((await get(intruder, `/api/v1/endpoints/${endpoint.id}/events`)).statusCode).toBe(404);
    expect((await get(intruder, `/api/v1/events/${id}`)).statusCode).toBe(404);
    expect((await get(intruder, `/api/v1/events/${id}/body`)).statusCode).toBe(404);
    expect((await get(owner, `/api/v1/events/${id}`)).statusCode).toBe(200);
  });

  test('requires authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/events/01960000-0000-7000-8000-000000000000',
    });
    expect(response.statusCode).toBe(401);
  });
});
