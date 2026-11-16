import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { redactUrl, serializeError } from './log-serializers.ts';

describe('redactUrl', () => {
  test.each([
    ['/in/abcdefghijklmnopqrstuv', '/in/[REDACTED]'],
    ['/in/abcdefghijklmnopqrstuv/github/push', '/in/[REDACTED]/github/push'],
    ['/in/abcdefghijklmnopqrstuv?token=t0k', '/in/[REDACTED]?[REDACTED]'],
    ['/in/abcdefghijklmnopqrstuv/x?a=1&b=2', '/in/[REDACTED]/x?[REDACTED]'],
    ['/in/', '/in/[REDACTED]'],
  ])('%s → %s', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  test.each(['/api/v1/events?cursor=abc', '/healthz', '/index', '/inbox/x', '/'])(
    'leaves %s alone',
    (url) => {
      expect(redactUrl(url)).toBe(url);
    },
  );
});

describe('serializeError', () => {
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'endpoints_slug_unique',
    detail: 'Key (slug)=(secret-slug-value) already exists.',
  });

  test('a Drizzle query error keeps the SQL and the cause, never the parameters', () => {
    const error = new DrizzleQueryError(
      'insert into "events" ("body", "headers") values ($1, $2)',
      ['secret-body\n    at fake (frame)', '{"authorization":"Bearer secret-header"}'],
      pgError,
    );
    const out = serializeError(error) as Record<string, unknown>;
    const text = JSON.stringify(out);

    expect(out.type).toBe('DrizzleQueryError');
    expect(out.message).toContain('Failed query: insert into "events"');
    expect(out.message).toContain('duplicate key value'); // the cause's message is kept
    expect(out.stack).toMatch(/\n\s+at /); // real stack frames survive
    expect(out.message).toContain('values ($1, $2)');
    for (const leak of ['secret-body', 'secret-header', 'fake (frame)', 'secret-slug-value']) {
      expect(text.includes(leak), leak).toBe(false);
    }
  });

  test('a raw Postgres error loses `detail` but keeps code and constraint', () => {
    const out = serializeError(pgError) as Record<string, unknown>;
    expect(out).toMatchObject({ code: '23505', constraint: 'endpoints_slug_unique' });
    expect(out.detail).toBeUndefined();
  });

  test('other errors serialize as before', () => {
    const out = serializeError(new TypeError('boom')) as Record<string, unknown>;
    expect(out).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect(serializeError('not an error')).toBe('not an error');
  });
});
