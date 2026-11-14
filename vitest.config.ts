import { defineConfig } from 'vitest/config';

const ENGINE_TESTS = 'apps/server/src/delivery/**/*.test.ts';

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
          exclude: [ENGINE_TESTS, '**/node_modules/**'],
        },
      },
      {
        // Delivery-engine tests: own database, tables reset per test, files run one at a time,
        // because the claim query deliberately sees every due delivery.
        extends: true,
        test: {
          name: 'engine',
          include: [ENGINE_TESTS],
          fileParallelism: false,
        },
      },
    ],
  },
});
