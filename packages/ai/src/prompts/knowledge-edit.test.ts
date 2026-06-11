import { describe, expect, it } from 'vitest'

import {
  buildKnowledgeEditPrompt,
  knowledgeEditSchema,
  VERSION,
} from './knowledge-edit'

describe('buildKnowledgeEditPrompt', () => {
  const base = {
    instruction: 'Change the Platinum tier hours to 105.',
    currentJson: '{"fullApplication":{"tiers":[{"tier":"Platinum","hours":100}]}}',
    today: '2026-06-17',
  }

  it('has a version', () => {
    expect(VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
  })

  it('grounds the system prompt on the current document and rules', () => {
    const { system } = buildKnowledgeEditPrompt(base)
    expect(system).toContain(base.currentJson)
    expect(system).toContain("Today's date: 2026-06-17")
    expect(system).toContain('Never invent prices')
    expect(system).toContain('Zoom or Teams')
    expect(system).toContain('dot notation')
  })

  it('puts the instruction in the user prompt', () => {
    const { user } = buildKnowledgeEditPrompt(base)
    expect(user).toContain('Platinum tier hours to 105')
  })
})

describe('knowledgeEditSchema', () => {
  it('accepts a summary + patch list', () => {
    const parsed = knowledgeEditSchema.safeParse({
      summary: 'Sets Platinum hours to 105.',
      patches: [{ op: 'replace', path: 'fullApplication.tiers.0.hours', value: 105 }],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts an empty patch list (clarification needed)', () => {
    expect(
      knowledgeEditSchema.safeParse({ summary: 'Need the new price.', patches: [] }).success,
    ).toBe(true)
  })

  it('rejects unknown ops and over-long patch lists', () => {
    expect(
      knowledgeEditSchema.safeParse({
        summary: 'x',
        patches: [{ op: 'move', path: 'a' }],
      }).success,
    ).toBe(false)
    expect(
      knowledgeEditSchema.safeParse({
        summary: 'x',
        patches: Array.from({ length: 21 }, (_, i) => ({
          op: 'remove' as const,
          path: `glossary.${i}`,
        })),
      }).success,
    ).toBe(false)
  })
})
