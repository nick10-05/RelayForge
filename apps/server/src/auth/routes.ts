import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import { sendRateLimited } from '../http/limits.ts';
import type { Limits } from '../http/limits.ts';
import { users } from '../db/schema.ts';
import { currentUser, requireUser, sessionCookieOptions } from './guard.ts';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.ts';
import { SESSION_COOKIE, createSession, deleteSession } from './sessions.ts';

const email = z.string().trim().toLowerCase().max(254);

const signupBody = z.object({
  email: email.pipe(z.email()),
  password: z.string().min(12).max(256),
});

const loginBody = z.object({
  email,
  password: z.string().min(1).max(256),
});

const INVALID_CREDENTIALS = {
  error: 'invalid_credentials',
  message: 'Email or password is incorrect',
} as const;

type UserRow = { id: string; email: string; createdAt: Date };
const toUserDto = (u: UserRow) => ({ id: u.id, email: u.email, createdAt: u.createdAt });

export type AuthRoutesOptions = { db: Db; limits: Pick<Limits, 'authIp' | 'loginEmail'> };

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, { db, limits }) => {
  app.post('/signup', { schema: { body: signupBody } }, async (request, reply) => {
    const ipLimit = limits.authIp.take(request.ip);
    if (!ipLimit.ok) return sendRateLimited(reply, ipLimit);
    const { email, password } = request.body;
    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email, createdAt: users.createdAt });

    if (!user) {
      // Trade-off: signup reveals that an email is registered (common UX choice);
      // login never does, and login is the endpoint attackers can hammer.
      return reply.code(409).send({ error: 'email_taken', message: 'Email is already registered' });
    }

    const session = await createSession(db, user.id);
    void reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return reply.code(201).send({ user: toUserDto(user) });
  });

  app.post('/login', { schema: { body: loginBody } }, async (request, reply) => {
    const { email, password } = request.body;
    // Checked before argon2id runs, so floods cost us almost nothing. Both buckets are
    // charged; the response is the same whichever one is empty (and says nothing about
    // whether the email exists — the per-email limit applies to any address).
    const ipLimit = limits.authIp.take(request.ip);
    const emailLimit = limits.loginEmail.take(email);
    if (!ipLimit.ok) return sendRateLimited(reply, ipLimit);
    if (!emailLimit.ok) return sendRateLimited(reply, emailLimit);
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user) {
      await verifyPassword(await dummyPasswordHash(), password); // equalise timing
      return reply.code(401).send(INVALID_CREDENTIALS);
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    // Always issue a fresh token on login (prevents session fixation); drop any old one.
    const previous = request.cookies[SESSION_COOKIE];
    if (previous) await deleteSession(db, previous);
    const session = await createSession(db, user.id);
    void reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    return reply.send({ user: toUserDto(user) });
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    void reply.clearCookie(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: requireUser(db) }, async (request) => {
    const { id } = currentUser(request);
    const [user] = await db
      .select({ id: users.id, email: users.email, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) throw new Error('session user missing');
    return { user: toUserDto(user) };
  });
};
