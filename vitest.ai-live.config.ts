// Live AI eval config. Hits the real OpenAI API. CLAUDE.md §18.3.
// Run nightly only; never on PR. Activated via `pnpm test:ai-live` and
// requires OPENAI_API_KEY in the environment.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/ai/evals/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Live calls are slow; allow generous per-test timeout.
    testTimeout: 60_000,
  },
})
