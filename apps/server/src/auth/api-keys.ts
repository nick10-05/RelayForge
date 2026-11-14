// API keys (design §7.3): `rf_live_<prefix>_<secret>`, for scripts and CI.
//
// Stored as the public `prefix` (indexed, used to find the row) + SHA-256(secret).
// A plain fast hash is right here — unlike passwords — because the secret is 256 random bits:
// there is nothing to guess or brute-force, so a slow KDF (argon2id) would only cost CPU on
// every request. Passwords are low-entropy and human-chosen, which is what a slow hash is for.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { apiKeys, users } from '../db/schema.ts';
import { NOT_FOUND } from '../http/errors.ts';
import { currentUser, requireUser } from './guard.ts';
import type { AuthUser } from './sessions.ts';

const KEY_PREFIX = 'rf_live_';
const KEY_FORMAT = /^rf_live_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
/** `last_used_at` is written at most this often per key, not on every request. */
const LAST_USED_RESOLUTION = sql`interval '1 minute'`;

const sha256 = (secret: string) => createHash('sha256').update(secret).digest();

export function generateApiKey(): { key: string; prefix: string; secretHash: string } {
  const prefix = randomBytes(6).toString('hex'); // 12 hex chars; never contains "_"
  const secret = randomBytes(32).toString('base64url'); // 256 bits, 43 chars
  return {
    key: `${KEY_PREFIX}${prefix}_${secret}`,
    prefix,
    secretHash: sha256(secret).toString('hex'),
  };
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  const match = KEY_FORMAT.exec(key);
  return match ? { prefix: match[1]!, secret: match[2]! } : null;
}

export const looksLikeApiKey = (token: string) => token.startsWith(KEY_PREFIX);

/** The key's user, or null (unknown, malformed, revoked, or wrong secret). */
export async function authenticateApiKey(db: Db, key: string): Promise<AuthUser | null> {
  const parsed = parseApiKey(key);
  if (!parsed) return null;
  const [row] = await db
    .select({
      id: apiKeys.id,
      secretHash: apiKeys.secretHash,
      userId: users.id,
      email: users.email,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;

  const stored = Buffer.from(row.secretHash, 'hex');
  const given = sha256(parsed.secret);
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;

  // Throttled: at most one write per key per minute, so busy scripts don't turn every
  // read request into a row update.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, row.id),
        sql`(${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < now() - ${LAST_USED_RESOLUTION})`,
      ),
    );
  return { id: row.userId, email: row.email };
}

type ApiKeyRow = typeof apiKeys.$inferSelect;
const toDto = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix, // shown so users can tell keys apart; useless without the secret
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  revokedAt: k.revokedAt,
});

/**
 * `/api/v1/api-keys` — session only: a leaked API key must not be able to mint new keys
 * or revoke the owner's other keys.
 */
export const apiKeyRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('preHandler', requireUser(db, { allowApiKey: false }));

  app.post(
    '/',
    { schema: { body: z.object({ name: z.string().trim().min(1).max(100) }) } },
    async (request, reply) => {
      const user = currentUser(request);
      for (let i = 0; i < 3; i++) {
        const generated = generateApiKey();
        const [row] = await db
          .insert(apiKeys)
          .values({
            userId: user.id,
            name: request.body.name,
            prefix: generated.prefix,
            secretHash: generated.secretHash,
          })
          .onConflictDoNothing({ target: apiKeys.prefix }) // 48-bit prefix: collisions are rare
          .returning();
        if (row) {
          // The full key is returned exactly once; only its hash is kept.
          return reply.code(201).send({ apiKey: toDto(row), key: generated.key });
        }
      }
      throw new Error('could not allocate a unique API key prefix');
    },
  );

  app.get('/', async (request) => {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, currentUser(request).id))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
    return { apiKeys: rows.map(toDto) };
  });

  /** Revoke (idempotent). The row is kept so the list still shows when it was revoked. */
  app.delete('/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (request, reply) => {
    const userId = currentUser(request).id;
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: sql`COALESCE(${apiKeys.revokedAt}, now())` })
      .where(and(eq(apiKeys.id, request.params.id), eq(apiKeys.userId, userId)))
      .returning({ id: apiKeys.id });
    if (!row) return reply.code(404).send(NOT_FOUND);
    return reply.code(204).send();
  });
};
