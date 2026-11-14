// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/', '**/dist/', '**/coverage/'] },

  js.configs.recommended,

  // TypeScript files: recommended + type-aware rules (need type information from tsconfig).
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An un-awaited promise loses its error (e.g. a lease never released).
      '@typescript-eslint/no-floating-promises': 'error',
      // An async function passed where a sync callback is expected.
      '@typescript-eslint/no-misused-promises': 'error',
      // A switch over a union (e.g. delivery status) must handle every case.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Fastify plugins and handlers are async by contract, even when they don't await.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
