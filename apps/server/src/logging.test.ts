// No secret value may appear in the logs (design §7.4, project rule). Runs every flow that
// handles a secret at LOG_LEVEL=trace and searches the captured output for each secret.
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { SESSION_COOKIE } from './auth/sessions.ts';
import { endpoints } from './db/schema.ts';
import { generateSigningSecret } from './delivery/signing.ts';
import { TEST_PASSWORD, createTestApp, signUp } from './testing/helpers.ts';

describe('logs never contain secrets', () => {
  const lines: string[] = [];
  const t = createTestApp(
    { LOG_LEVEL: 'trace' },
    { logStream: { write: (l) => void lines.push(l) } },
  );
  const { app, db } = t;
  afterAll(() => t.close());

  test('auth, endpoint/destination secrets, API keys, signed and forged ingest, crypto errors', async () => {
    const user = await signUp(app);
    const sessionToken = user.cookie.slice(`${SESSION_COOKIE}=`.length);
    const auth = { cookie: user.cookie };

    // Login (password in the body).
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: TEST_PASSWORD },
    });

    // Endpoint with an HMAC verify secret; another with a standard_webhooks secret.
    const verifySecret = 'verify-secret-do-not-log';
    const swSecret = generateSigningSecret();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/endpoints',
      payload: {
        name: 'gh',
        verification: {
          scheme: 'hmac',
          header: 'x-hub-signature-256',
          prefix: 'sha256=',
          encoding: 'hex',
          secret: verifySecret,
        },
      },
      headers: auth,
    });
    const endpoint = created.json<{ endpoint: { id: string; slug: string } }>().endpoint;
    await app.inject({
      method: 'POST',
      url: '/api/v1/endpoints',
      payload: { name: 'sw', verification: { scheme: 'standard_webhooks', secret: swSecret } },
      headers: auth,
    });

    // Destination: signing secret on create, read, rotate.
    const dest = await app.inject({
      method: 'POST',
      url: `/api/v1/endpoints/${endpoint.id}/destinations`,
      payload: { url: 'https://example.com/hook' },
      headers: auth,
    });
    const { destination, signingSecret } = dest.json<{
      destination: { id: string };
      signingSecret: string;
    }>();
    const base = `/api/v1/endpoints/${endpoint.id}/destinations/${destination.id}`;
    await app.inject({ url: `${base}/secret`, headers: auth });
    const rotated = await app.inject({
      method: 'POST',
      url: `${base}/rotate-secret`,
      headers: auth,
    });
    const newSigningSecret = rotated.json<{ signingSecret: string }>().signingSecret;

    // API key: create and use.
    const keyResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      payload: { name: 'ci' },
      headers: auth,
    });
    const apiKey = keyResponse.json<{ key: string }>().key;
    await app.inject({ url: '/api/v1/endpoints', headers: { authorization: `Bearer ${apiKey}` } });
    await app.inject({ url: '/api/v1/endpoints', headers: { authorization: `Bearer ${apiKey}x` } });

    // Ingest: signed (valid) and forged (invalid).
    const body = '{"action":"opened"}';
    const signature = `sha256=${createHmac('sha256', verifySecret).update(body).digest('hex')}`;
    const ingest = (sig: string) =>
      app.inject({
        method: 'POST',
        url: `/in/${endpoint.slug}`,
        payload: body,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      });
    await ingest(signature);
    await ingest('sha256=00');

    // A crypto failure path that logs an error (sealed secret moved to the wrong row).
    const [other] = await db.select().from(endpoints).where(eq(endpoints.name, 'sw')).limit(1);
    await db
      .update(endpoints)
      .set({ verifySecretEnc: other!.verifySecretEnc })
      .where(eq(endpoints.id, endpoint.id));
    await ingest(signature);

    // Code that logs secret-bearing objects directly is redacted too.
    app.log.info(
      {
        password: TEST_PASSWORD,
        secret: verifySecret,
        token: sessionToken,
        key: apiKey,
        signingSecret,
        headers: { authorization: `Bearer ${apiKey}`, 'x-hub-signature-256': signature },
        config: { verification: { secret: swSecret } },
      },
      'probe',
    );

    const output = lines.join('');
    expect(output).toContain('incoming request'); // logging really was on
    expect(output).toContain('cannot open verify secret'); // and the error path ran
    for (const secret of [
      TEST_PASSWORD,
      sessionToken,
      verifySecret,
      swSecret,
      signingSecret,
      newSigningSecret,
      apiKey,
      // The secret part alone: the last 43 chars. (Not split('_'): base64url contains "_", so a
      // split could leave a 1–2 char fragment that appears in any log by chance — a flaky test.)
      apiKey.slice(-43),
      signature.slice('sha256='.length),
      endpoint.slug, // the ingest URL is a capability (logged as /in/[REDACTED])
    ]) {
      expect(output.includes(secret), `log output contains a secret (${secret.slice(0, 4)}…)`).toBe(
        false,
      );
    }
    const probe = lines.find((l) => l.includes('"probe"'))!;
    expect(probe.match(/\[REDACTED\]/g)!.length).toBeGreaterThanOrEqual(8);
  });
});
