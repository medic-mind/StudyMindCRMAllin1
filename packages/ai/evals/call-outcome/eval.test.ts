// Schema-only eval for the call-outcome prompt. CLAUDE.md §18.3.
// Runs in CI on every PR. Live variant lives in eval.live.test.ts.

import { describe, expect, it } from 'vitest'

import {
  buildCallOutcomePrompt,
  callOutcomeSchema,
  type CallOutcome,
  type CallOutcomePromptInput,
} from '../../src/prompts/call-outcome.js'
import { loadFixtures } from '../run.js'

const fixtures = loadFixtures<CallOutcomePromptInput, CallOutcome>(__dirname)

describe('call-outcome eval (schema)', () => {
  for (const f of fixtures) {
    it(`fixture ${f.name}: builds a prompt and expected output parses`, () => {
      const prompt = buildCallOutcomePrompt(f.input)
      expect(prompt.system.length).toBeGreaterThan(0)
      expect(prompt.user.length).toBeGreaterThan(0)
      const parsed = callOutcomeSchema.parse(f.expected)
      expect(parsed.outcome).toBe(f.expected.outcome)
    })
  }
})
