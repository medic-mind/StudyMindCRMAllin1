// Schema-only eval for slack-summary. CLAUDE.md §18.3.

import { describe, expect, it } from 'vitest'

import {
  buildSlackSummaryPrompt,
  slackSummarySchema,
  type SlackSummary,
  type SlackSummaryPromptInput,
} from '../../src/prompts/slack-summary'
import { loadFixtures } from '../run'

const fixtures = loadFixtures<SlackSummaryPromptInput, SlackSummary>(__dirname)

describe('slack-summary eval (schema)', () => {
  for (const f of fixtures) {
    it(`fixture ${f.name}: schema parses`, () => {
      const prompt = buildSlackSummaryPrompt(f.input)
      expect(prompt.user).toContain('Channel:')
      slackSummarySchema.parse(f.expected)
    })
  }
})
