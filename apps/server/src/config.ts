import { z } from 'zod';
import { KeyringError, parseKeyring } from './crypto/secret-box.ts';

const postgresUrl = z
  .string()
  .refine((value) => /^postgres(ql)?:\/\/.+/.test(value), 'must be a postgres:// URL');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: postgresUrl,
  DATABASE_DIRECT_URL: postgresUrl.optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  // Max deliveries sent at the same time by this process's worker.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  // Dev-only escape hatch so destinations can point at localhost receivers. Refused in production.
  ALLOW_PRIVATE_DESTINATIONS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Secret encryption keyring (design §7.4): "<keyId>:<base64 32 bytes>[,...]" + active id.
  // Required outside tests; tests build their own keyring.
  ENCRYPTION_KEYS: z.string().optional(),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),
  // Browser origins allowed to make state-changing API calls (CSRF check, design §7.3).
  // Comma-separated. Required in production (the public URL).
  APP_ORIGIN: z
    .string()
    .refine(
      (v) => v.split(',').every((o) => isOrigin(o.trim())),
      'must be comma-separated origins like https://app.example.com',
    )
    .optional(),
  // Abuse limits (design §7.5).
  INGEST_RATE_PER_SECOND: z.coerce.number().positive().max(10_000).default(20),
  INGEST_BURST: z.coerce.number().int().min(1).max(100_000).default(100),
  INVALID_SIGNATURE_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  STORAGE_CAP_BYTES: z.coerce
    .number()
    .int()
    .min(1_000_000)
    .default(512 * 1024 * 1024),
});

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

const configSchemaWithRules = configSchema.superRefine((config, ctx) => {
  if (config.NODE_ENV === 'production' && config.ALLOW_PRIVATE_DESTINATIONS) {
    ctx.addIssue({
      code: 'custom',
      path: ['ALLOW_PRIVATE_DESTINATIONS'],
      message: 'must not be true in production',
    });
  }
  if (config.NODE_ENV === 'production' && config.APP_ORIGIN === undefined) {
    ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'is required in production' });
  }
  const { ENCRYPTION_KEYS: keys, ENCRYPTION_ACTIVE_KEY_ID: active } = config;
  if (keys === undefined || active === undefined) {
    if (config.NODE_ENV !== 'test') {
      for (const name of ['ENCRYPTION_KEYS', 'ENCRYPTION_ACTIVE_KEY_ID'] as const) {
        if (config[name] === undefined) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'is required' });
        }
      }
    }
    return;
  }
  try {
    parseKeyring(keys, active);
  } catch (error) {
    // KeyringError messages name ids and positions only, never key material.
    const message = error instanceof KeyringError ? error.message : 'is invalid';
    ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEYS'], message });
  }
});

export type Config = Omit<z.infer<typeof configSchema>, 'DATABASE_DIRECT_URL'> & {
  DATABASE_DIRECT_URL: string;
};

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Validates environment variables at startup. Fails fast with every problem listed.
 * Error messages name the variable and the rule, never the value (it may be a secret).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as unset, so `PORT=` falls back to the default instead of failing oddly.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));

  const result = configSchemaWithRules.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const parsed = result.data;
  return { ...parsed, DATABASE_DIRECT_URL: parsed.DATABASE_DIRECT_URL ?? parsed.DATABASE_URL };
}
