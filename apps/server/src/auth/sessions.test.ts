import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { sessions, users } from '../db/schema.ts';
import { createTestApp, uniqueEmail } from '../testing/helpers.ts';
import {
  SESSION_REFRESH_MS,
  SESSION_TTL_MS,
  createSession,
  deleteSession,
  hashSessionToken,
  validateSession,
} from './sessions.ts';

describe('sessions', () => {
  const t = createTestApp();
  afterAll(() => t.close());

  async function newUser() {
    const [user] = await t.db
      .insert(users)
      .values({ email: uniqueEmail(), passwordHash: 'x' })
      .returning({ id: users.id });
    if (!user) throw new Error('no user');
    return user.id;
  }

  test('stores only the SHA-256 of the token', async () => {
    const userId = await newUser();
    const { token } = await createSession(t.db, userId);
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashSessionToken(token));
    expect(rows[0]?.tokenHash).not.toContain(token);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  test('a valid token returns the user', async () => {
    const userId = await newUser();
    const { token } = await createSession(t.db, userId);
    const session = await validateSession(t.db, token);
    expect(session?.user.id).toBe(userId);
    expect(session?.renewed).toBe(false);
  });

  test('unknown, empty and oversized tokens are rejected', async () => {
    expect(await validateSession(t.db, 'nope')).toBeNull();
    expect(await validateSession(t.db, '')).toBeNull();
    expect(await validateSession(t.db, 'x'.repeat(500))).toBeNull();
  });

  test('an expired session is rejected and deleted', async () => {
    const userId = await newUser();
    const start = new Date('2026-01-01T00:00:00Z');
    const { token } = await createSession(t.db, userId, start);
    const later = new Date(start.getTime() + SESSION_TTL_MS + 1);
    expect(await validateSession(t.db, token, later)).toBeNull();
    const rows = await t.db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(0);
  });

  test('sliding expiry: renewed after the refresh interval, not before', async () => {
    const userId = await newUser();
    const start = new Date('2026-01-01T00:00:00Z');
    const { token, expiresAt } = await createSession(t.db, userId, start);

    const soon = new Date(start.getTime() + SESSION_REFRESH_MS - 1000);
    const early = await validateSession(t.db, token, soon);
    expect(early?.renewed).toBe(false);
    expect(early?.expiresAt.getTime()).toBe(expiresAt.getTime());

    const later = new Date(start.getTime() + SESSION_REFRESH_MS + 1000);
    const renewed = await validateSession(t.db, token, later);
    expect(renewed?.renewed).toBe(true);
    expect(renewed?.expiresAt.getTime()).toBe(later.getTime() + SESSION_TTL_MS);
  });

  test('deleteSession revokes the token', async () => {
    const userId = await newUser();
    const { token } = await createSession(t.db, userId);
    await deleteSession(t.db, token);
    expect(await validateSession(t.db, token)).toBeNull();
  });
});
