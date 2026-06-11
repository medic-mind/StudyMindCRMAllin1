import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import {
  applyKnowledgePatches,
  getAtPath,
  knowledgePatchSchema,
  MAX_KNOWLEDGE_DOCUMENT_CHARS,
} from './patches'
import type { KnowledgeValue } from './types'

const doc: Record<string, KnowledgeValue> = {
  fullApplication: {
    tiers: [
      { tier: 'Bronze', hours: 60 },
      { tier: 'Platinum', hours: 100 },
    ],
    hourFlexibility: 'Hours can be shared.',
  },
  glossary: [{ term: 'DoE', definition: 'Duke of Edinburgh' }],
}

describe('applyKnowledgePatches', () => {
  it('replaces a nested value without mutating the input', () => {
    const next = applyKnowledgePatches(doc, [
      { op: 'replace', path: 'fullApplication.tiers.1.hours', value: 105 },
    ])
    expect(getAtPath(next, 'fullApplication.tiers.1.hours').value).toBe(105)
    expect(getAtPath(doc, 'fullApplication.tiers.1.hours').value).toBe(100)
  })

  it('adds a new object key', () => {
    const next = applyKnowledgePatches(doc, [
      { op: 'add', path: 'fullApplication.ucatNote', value: 'UCAT included' },
    ])
    expect(getAtPath(next, 'fullApplication.ucatNote').value).toBe('UCAT included')
  })

  it('adds a whole new top-level section', () => {
    const next = applyKnowledgePatches(doc, [
      { op: 'add', path: 'refundPolicy', value: { summary: 'New policy' } },
    ])
    expect(getAtPath(next, 'refundPolicy.summary').value).toBe('New policy')
  })

  it('appends to an array with "-" and with index == length', () => {
    const viaDash = applyKnowledgePatches(doc, [
      { op: 'add', path: 'glossary.-', value: { term: 'VA', definition: 'Virtual assistant' } },
    ])
    const viaIndex = applyKnowledgePatches(doc, [
      { op: 'add', path: 'glossary.1', value: { term: 'VA', definition: 'Virtual assistant' } },
    ])
    expect(getAtPath(viaDash, 'glossary.1.term').value).toBe('VA')
    expect(getAtPath(viaIndex, 'glossary.1.term').value).toBe('VA')
  })

  it('removes an object key and an array element', () => {
    const next = applyKnowledgePatches(doc, [
      { op: 'remove', path: 'fullApplication.hourFlexibility' },
      { op: 'remove', path: 'glossary.0' },
    ])
    expect(getAtPath(next, 'fullApplication.hourFlexibility').found).toBe(false)
    expect(getAtPath(next, 'glossary.0').found).toBe(false)
  })

  it('applies patches in order (later patches see earlier results)', () => {
    const next = applyKnowledgePatches(doc, [
      { op: 'add', path: 'faq', value: [] },
      { op: 'add', path: 'faq.-', value: { question: 'Q1', answer: 'A1' } },
    ])
    expect(getAtPath(next, 'faq.0.question').value).toBe('Q1')
  })

  it('rejects a replace at a missing path', () => {
    expect(() =>
      applyKnowledgePatches(doc, [{ op: 'replace', path: 'fullApplication.nope', value: 1 }]),
    ).toThrowError(BusinessError)
  })

  it('rejects an add over an existing key', () => {
    expect(() =>
      applyKnowledgePatches(doc, [
        { op: 'add', path: 'fullApplication.hourFlexibility', value: 'x' },
      ]),
    ).toThrowError(/already exists/)
  })

  it('rejects an out-of-range array index', () => {
    expect(() =>
      applyKnowledgePatches(doc, [{ op: 'replace', path: 'glossary.9.term', value: 'x' }]),
    ).toThrowError(BusinessError)
  })

  it('rejects an empty patch list', () => {
    expect(() => applyKnowledgePatches(doc, [])).toThrowError(BusinessError)
  })

  it('fails closed on Zoom/Teams content — the Crib hard rule', () => {
    for (const banned of [
      'Join at https://zoom.us/j/123',
      'teams.microsoft.com/l/meetup',
      'Passcode: 9981',
    ]) {
      expect(() =>
        applyKnowledgePatches(doc, [
          { op: 'replace', path: 'fullApplication.hourFlexibility', value: banned },
        ]),
      ).toThrowError(/Zoom\/Teams/)
    }
  })

  it('rejects growth beyond the document ceiling', () => {
    expect(() =>
      applyKnowledgePatches(doc, [
        { op: 'add', path: 'huge', value: 'x'.repeat(MAX_KNOWLEDGE_DOCUMENT_CHARS) },
      ]),
    ).toThrowError(/ceiling/)
  })
})

describe('getAtPath', () => {
  it('walks objects and array indices', () => {
    expect(getAtPath(doc, 'fullApplication.tiers.0.tier')).toEqual({
      found: true,
      value: 'Bronze',
    })
    expect(getAtPath(doc, 'fullApplication.missing')).toEqual({ found: false })
    expect(getAtPath(doc, 'glossary.-')).toEqual({ found: false })
  })
})

describe('knowledgePatchSchema', () => {
  it('accepts the three ops and any JSON value', () => {
    expect(
      knowledgePatchSchema.safeParse({ op: 'add', path: 'a.b', value: { nested: [1, null] } })
        .success,
    ).toBe(true)
    expect(knowledgePatchSchema.safeParse({ op: 'remove', path: 'a' }).success).toBe(true)
  })

  it('rejects unknown ops and empty paths', () => {
    expect(knowledgePatchSchema.safeParse({ op: 'move', path: 'a' }).success).toBe(false)
    expect(knowledgePatchSchema.safeParse({ op: 'add', path: '' }).success).toBe(false)
  })
})
