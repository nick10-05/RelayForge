import { afterAll, describe, expect, test } from 'vitest';
import { TEST_PASSWORD, createTestApp, signUp, uniqueEmail } from '../testing/helpers.ts';
import { SESSION_COOKIE } from './sessions.ts';

describe('auth routes', () => {
  const { app, close } = createTestApp();
  afterAll(close);

  const login = (email: string, password: string, cookie?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
      ...(cookie && { headers: { cookie } }),
    });

  const me = (cookie?: string) =>
    app.inject({ method: 'GET', url: '/api/v1/auth/me', ...(cookie && { headers: { cookie } }) });

  test('signup creates the user, lower-cases the email and logs in', async () => {
    const email = uniqueEmail().toUpperCase();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: `  ${email}  `, password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ user: Record<string, unknown> }>();
    expect(body.user['email']).toBe(email.toLowerCase());
    expect(body.user).not.toHaveProperty('passwordHash');

    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect((await me(`${SESSION_COOKIE}=${cookie?.value}`)).statusCode).toBe(200);
  });

  test('signup rejects a duplicate email (case-insensitive) with 409', async () => {
    const user = await signUp(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: user.email.toUpperCase(), password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'email_taken' });
  });

  test.each([
    ['invalid email', { email: 'not-an-email', password: TEST_PASSWORD }],
    ['short password', { email: 'a@example.test', password: 'short' }],
    ['missing password', { email: 'a@example.test' }],
  ])('signup validates input: %s', async (_name, payload) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'validation_error' });
  });

  test('login with the right password sets a new session', async () => {
    const user = await signUp(app);
    const response = await login(user.email, TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(`${SESSION_COOKIE}=${cookie?.value}`).not.toBe(user.cookie);
  });

  test('wrong password and unknown email give the identical response', async () => {
    const user = await signUp(app);
    const wrong = await login(user.email, 'definitely the wrong password');
    const unknown = await login(uniqueEmail(), 'definitely the wrong password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.cookies).toHaveLength(0);
  });

  test('login replaces the session presented in the cookie (no fixation)', async () => {
    const user = await signUp(app);
    const response = await login(user.email, TEST_PASSWORD, user.cookie);
    expect(response.statusCode).toBe(200);
    expect((await me(user.cookie)).statusCode).toBe(401);
  });

  test('logout revokes the session and clears the cookie', async () => {
    const user = await signUp(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: user.cookie },
    });
    expect(response.statusCode).toBe(204);
    const cleared = response.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe('');
    expect((await me(user.cookie)).statusCode).toBe(401);
  });

  test('/me requires a valid session', async () => {
    expect((await me()).statusCode).toBe(401);
    expect((await me(`${SESSION_COOKIE}=forged-token`)).statusCode).toBe(401);
    const user = await signUp(app);
    const response = await me(user.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: user.id, email: user.email } });
  });
});
