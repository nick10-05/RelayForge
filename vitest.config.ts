import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts'],
    globalSetup: ['./apps/server/src/testing/global-setup.ts'],
  },
});
