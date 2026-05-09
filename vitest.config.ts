// Root Vitest config. Each package can extend or replace as it grows.

import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      // Webhook contract tests for external services. Replays of sanitised
      // captured payloads — see CLAUDE.md §23 (testing strategy).
      '__tests__/contract/**/*.test.ts',
      // Integration tests with mocked DBs / external clients.
      '__tests__/integration/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.turbo/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: {
      // Mirror apps/web/tsconfig.json's `@/*` path alias so route handlers
      // imported from contract tests resolve their `@/lib/...` imports.
      '@': resolve(__dirname, 'apps/web'),
    },
  },
})
