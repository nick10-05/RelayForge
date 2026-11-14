import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const DB = 'postgres://user:s3cret-value@localhost:5433/relayforge_dev';

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  test('applies defaults when only DATABASE_URL is set', () => {
    const config = loadConfig({ DATABASE_URL: DB });
    expect(config).toEqual({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: DB,
      DATABASE_DIRECT_URL: DB,
      SHUTDOWN_TIMEOUT_MS: 10000,
    });
  });

  test('parses provided values and coerces numbers', () => {
    const config = loadConfig({
      DATABASE_URL: DB,
      DATABASE_DIRECT_URL: 'postgresql://direct@localhost/db',
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      SHUTDOWN_TIMEOUT_MS: '5000',
    });
    expect(config.PORT).toBe(8080);
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(5000);
    expect(config.DATABASE_DIRECT_URL).toBe('postgresql://direct@localhost/db');
    expect(config.NODE_ENV).toBe('production');
  });

  test('treats empty strings as unset', () => {
    expect(loadConfig({ DATABASE_URL: DB, PORT: '' }).PORT).toBe(3000);
  });

  test('ignores unrelated environment variables', () => {
    expect(() => loadConfig({ DATABASE_URL: DB, PATH: '/usr/bin' })).not.toThrow();
  });

  test('requires DATABASE_URL', () => {
    expect(errorOf(() => loadConfig({})).issues.some((i) => i.startsWith('DATABASE_URL'))).toBe(
      true,
    );
  });

  test('rejects a non-postgres DATABASE_URL', () => {
    const error = errorOf(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db' }));
    expect(error.issues).toEqual(['DATABASE_URL: must be a postgres:// URL']);
  });

  test.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['SHUTDOWN_TIMEOUT_MS', '10'],
  ])('rejects invalid %s=%s', (key, value) => {
    const error = errorOf(() => loadConfig({ DATABASE_URL: DB, [key]: value }));
    expect(error.issues.some((i) => i.startsWith(`${key}:`))).toBe(true);
  });

  test('reports every invalid variable at once', () => {
    const error = errorOf(() => loadConfig({ PORT: 'abc', NODE_ENV: 'staging' }));
    expect(error.issues).toHaveLength(3);
  });

  test('never includes values in the error message', () => {
    const error = errorOf(() =>
      loadConfig({ DATABASE_URL: 'mysql://user:s3cret-value@host/db', PORT: 'abc' }),
    );
    expect(error.message).not.toContain('s3cret-value');
    expect(error.message).not.toContain('abc');
  });
});
