// Schema-only eval for status-summary. CLAUDE.md §18.3.

import { describe, expect, it } from 'vitest'

import {
  buildStatusSummaryPrompt,
  statusSummarySchema,
  type StatusSummary,
  type StatusSummaryPromptInput,
} from '../../src/prompts/status-summary'
import { loadFixtures } from '../run'

const fixtures = loadFixtures<StatusSummaryPromptInput, StatusSummary>(__dirname)

describe('status-summary eval (schema)', () => {
  for (const f of fixtures) {
    it(`fixture ${f.name}: schema parses`, () => {
      buildStatusSummaryPrompt(f.input)
      const parsed = statusSummarySchema.parse(f.expected)
      expect(parsed.headerLine.length).toBeGreaterThan(0)
    })
  }
})
