// Live AI eval — call-outcome. Runs only with OPENAI_API_KEY set.
// CLAUDE.md §18.3 — nightly only, never on PR.

import { describe, expect, it } from 'vitest'

import { runStructured } from '../../src/clients/structured.js'
import {
  buildCallOutcomePrompt,
  callOutcomeSchema,
  type CallOutcome,
  type CallOutcomePromptInput,
} from '../../src/prompts/call-outcome.js'
import { isLiveEvalEnabled, loadFixtures } from '../run.js'

const fixtures = loadFixtures<CallOutcomePromptInput, CallOutcome>(__dirname)

describe.skipIf(!isLiveEvalEnabled())('call-outcome eval (live)', () => {
  for (const f of fixtures) {
    it(`fixture ${f.name}: live model agrees on outcome`, async () => {
      const prompt = buildCallOutcomePrompt(f.input)
      const out = await runStructured({
        task: 'call_outcome_classification',
        promptVersion: prompt.promptVersion,
        schema: callOutcomeSchema,
        schemaName: 'CallOutcome',
        system: prompt.system,
        user: prompt.user,
        model: 'gpt-4o-mini',
      })
      expect(out.outcome).toBe(f.expected.outcome)
    })
  }
})
