import { z } from 'zod';

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

  const result = configSchema.safeParse(cleaned);
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
