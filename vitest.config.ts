import { defineConfig } from 'vitest/config';

// Tests that see or change the whole database (the claim query takes any due delivery;
// retention deletes across tenants; e2e runs a real worker): own DB, run one file at a time.
const ENGINE_TESTS = [
  'apps/server/src/delivery/**/*.test.ts',
  'apps/server/src/ops/retention.test.ts',
  'apps/server/src/e2e/**/*.test.ts',
];

export default defineConfig({
  test: {
    globalSetup: ['./apps/server/src/testing/global-setup.ts'],
    projects: [
      {
        // API and unit tests: isolated by data (fresh user per test), files run in parallel.
        extends: true,
        test: {
          name: 'api',
          include: ['apps/*/src/**/*.test.ts'],
          exclude: [...ENGINE_TESTS, '**/node_modules/**'],
        },
      },
      {
        // Delivery-engine tests: own database, tables reset per test, files run one at a time,
        // because the claim query deliberately sees every due delivery.
        extends: true,
        test: {
          name: 'engine',
          include: ENGINE_TESTS,
          fileParallelism: false,
        },
      },
    ],
  },
});
