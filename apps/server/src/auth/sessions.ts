import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';

export const SESSION_COOKIE = '__Host-rf_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often, so not every request writes to the DB. */
export const SESSION_REFRESH_MS = 60 * 60 * 1000;

export type AuthUser = { id: string; email: string };

/** Only the SHA-256 of a token is stored: a DB leak doesn't hand out live sessions. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    createdAt: now,
    lastSeenAt: now,
  });
  return { token, expiresAt };
}

export type ValidSession = { user: AuthUser; expiresAt: Date; renewed: boolean };

export async function validateSession(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<ValidSession | null> {
  if (token.length === 0 || token.length > 128) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashSessionToken(token)))
    .limit(1);

  if (!row) return null;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    return null;
  }

  const user = { id: row.userId, email: row.email };
  if (now.getTime() - row.lastSeenAt.getTime() < SESSION_REFRESH_MS) {
    return { user, expiresAt: row.expiresAt, renewed: false };
  }

  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db
    .update(sessions)
    .set({ expiresAt, lastSeenAt: now })
    .where(eq(sessions.id, row.sessionId));
  return { user, expiresAt, renewed: true };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}
