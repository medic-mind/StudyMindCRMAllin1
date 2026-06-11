import { describe, expect, it } from 'vitest'

import {
  buildKnowledgeQaPrompt,
  knowledgeAnswerShape,
  VERSION,
} from './knowledge-qa'

describe('buildKnowledgeQaPrompt', () => {
  const base = {
    question: 'How many hours come with the Platinum tier?',
    contextJson: '{"fullApplication":{"tiers":[{"tier":"Platinum","hours":100}]}}',
    today: '2026-06-11',
  }

  it('has a version', () => {
    expect(VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
  })

  it('grounds the system prompt on the context JSON and the date', () => {
    const { system } = buildKnowledgeQaPrompt(base)
    expect(system).toContain(base.contextJson)
    expect(system).toContain("Today's date: 2026-06-11")
    expect(system).toContain('ONLY the company knowledge JSON')
    expect(system).toContain('Never share the Partnerships email')
    expect(system).toContain('Becca')
  })

  it('puts the question in the user prompt', () => {
    const { user } = buildKnowledgeQaPrompt(base)
    expect(user).toContain('Platinum tier')
    expect(user).not.toContain('Conversation so far')
  })

  it('renders prior turns as labelled history', () => {
    const { user } = buildKnowledgeQaPrompt({
      ...base,
      history: [
        { role: 'user', content: 'What is the Full Application Scheme?' },
        { role: 'assistant', content: 'A bundled package with four tiers.' },
      ],
    })
    expect(user).toContain('Conversation so far:')
    expect(user).toContain('Staff: What is the Full Application Scheme?')
    expect(user).toContain('Assistant: A bundled package with four tiers.')
    // The new question always comes last.
    expect(user.indexOf('Staff question:')).toBeGreaterThan(user.indexOf('Conversation so far:'))
  })

  it('accepts a normal answer and rejects an empty or over-long one', () => {
    expect(knowledgeAnswerShape.safeParse('Platinum includes 100 hours.').success).toBe(true)
    expect(knowledgeAnswerShape.safeParse('').success).toBe(false)
    expect(knowledgeAnswerShape.safeParse('x'.repeat(4001)).success).toBe(false)
  })
})
