// Tests for the studymind/release-flag-staleness ESLint rule.
// CLAUDE.md §31.

import { RuleTester } from 'eslint'
import { describe, it, beforeAll, afterAll } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('./release-flag-staleness.js')

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

const REGISTRY_PATH = 'packages/core/src/flags/registry.ts'

beforeAll(() => {
  process.env.STALE_FLAG_NOW = '2026-05-09T00:00:00Z'
})

afterAll(() => {
  delete process.env.STALE_FLAG_NOW
})

describe('studymind/release-flag-staleness', () => {
  it('skips files outside the flag registry', () => {
    ruleTester.run('release-flag-staleness', rule, {
      valid: [
        {
          filename: 'packages/some/other.ts',
          code: `const FLAGS = { 'a.b': { kind: 'release', firstShippedAt: '2025-01-01' } }`,
        },
      ],
      invalid: [],
    })
  })

  it('flags release flags older than 30 days inside the registry', () => {
    ruleTester.run('release-flag-staleness', rule, {
      valid: [
        // Recent release flag — within 30 days.
        {
          filename: REGISTRY_PATH,
          code: `const FLAGS = { 'a.b': { kind: 'release', default: false, firstShippedAt: '2026-04-30', owner: 'x', description: '' } }`,
        },
        // Operational flag — exempt.
        {
          filename: REGISTRY_PATH,
          code: `const FLAGS = { 'a.b': { kind: 'operational', default: true, firstShippedAt: '2024-01-01', owner: 'x', description: '' } }`,
        },
        // Release flag without firstShippedAt — opt-out, accepted.
        {
          filename: REGISTRY_PATH,
          code: `const FLAGS = { 'a.b': { kind: 'release', default: false, owner: 'x', description: '' } }`,
        },
      ],
      invalid: [
        {
          filename: REGISTRY_PATH,
          code: `const FLAGS = { 'a.b': { kind: 'release', default: false, owner: 'x', description: '', firstShippedAt: '2025-01-01' } }`,
          errors: [{ messageId: 'stale' }],
        },
      ],
    })
  })
})
