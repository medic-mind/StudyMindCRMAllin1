// Schema-only eval for churn-score. CLAUDE.md §18.3.

import { describe, expect, it } from 'vitest'

import {
  buildChurnScorePrompt,
  churnScoreSchema,
  type ChurnScoreOutput,
  type ChurnScorePromptInput,
} from '../../src/prompts/churn-score.js'
import { loadFixtures } from '../run.js'

const fixtures = loadFixtures<ChurnScorePromptInput, ChurnScoreOutput>(__dirname)

describe('churn-score eval (schema)', () => {
  for (const f of fixtures) {
    it(`fixture ${f.name}: schema parses`, () => {
      buildChurnScorePrompt(f.input)
      const parsed = churnScoreSchema.parse(f.expected)
      expect(parsed.score).toBeGreaterThanOrEqual(0)
      expect(parsed.score).toBeLessThanOrEqual(1)
    })
  }
})
