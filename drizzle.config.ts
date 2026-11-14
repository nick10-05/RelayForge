import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile();
} catch {
  // No .env file (e.g. CI): use the real environment.
}

// Migrations use the direct (non-pooled) URL: Neon's pooled endpoint is PgBouncer
// in transaction mode, which is unsafe for DDL sessions.
const url = process.env['DATABASE_DIRECT_URL'] ?? process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL must be set for migrations');

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/server/src/db/schema.ts',
  out: './apps/server/drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
