import { describe, expect, it } from 'vitest'

import { buildKnowledgeContext } from './context'
import { knowledgeSectionPlainText, renderToPlainText } from './plain-text'
import { humaniseKey, toRenderTree } from './render-tree'
import { searchKnowledge } from './search'
import { getKnowledgeData, KNOWLEDGE_SECTIONS } from './sections'
import {
  baselineKnowledgeStore,
  buildKnowledgeStore,
  getKnowledgeSection,
  getKnowledgeSectionData,
  loadKnowledgeStore,
} from './store'

const store = baselineKnowledgeStore()

describe('knowledge manifest completeness', () => {
  it('maps every top-level data key to exactly one section', () => {
    const dataKeys = Object.keys(getKnowledgeData()).sort()
    const manifestKeys = KNOWLEDGE_SECTIONS.map((s) => s.dataKey).sort()
    // A failure here means the imported data and the section manifest have
    // drifted — a re-import added or removed a top-level key. Update
    // sections.ts so nothing silently disappears from the UI.
    expect(manifestKeys).toEqual(dataKeys)
  })

  it('has unique slugs', () => {
    const slugs = KNOWLEDGE_SECTIONS.map((s) => s.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('resolves every section to data', () => {
    for (const section of KNOWLEDGE_SECTIONS) {
      expect(getKnowledgeSectionData(store, section.slug), section.slug).toBeDefined()
      expect(getKnowledgeSection(store, section.slug)?.title.length).toBeGreaterThan(0)
    }
  })

  it('returns undefined for an unknown slug', () => {
    expect(getKnowledgeSection(store, 'not-a-section')).toBeUndefined()
    expect(getKnowledgeSectionData(store, 'not-a-section')).toBeUndefined()
  })
})

describe('knowledge content policy', () => {
  it('contains no Zoom or Teams URLs, meeting IDs or passcodes', () => {
    // The Crib's one universal hard rule, ported with the content: meeting
    // links flow to paid students via the booking system only.
    const raw = JSON.stringify(getKnowledgeData()).toLowerCase()
    expect(raw).not.toMatch(/zoom\.us/)
    expect(raw).not.toMatch(/teams\.microsoft\.com/)
    expect(raw).not.toMatch(/passcode/)
  })
})

describe('knowledge store', () => {
  it('exposes the manifest sections for the baseline', () => {
    expect(store.edited).toBe(false)
    expect(store.version).toBe('baseline')
    expect(store.sections.map((s) => s.slug).sort()).toEqual(
      KNOWLEDGE_SECTIONS.map((s) => s.slug).sort(),
    )
  })

  it('derives a Custom section for a top-level key added in-app', () => {
    const custom = buildKnowledgeStore({
      data: { ...getKnowledgeData(), refundPolicy2027: { summary: 'New policy' } },
      version: 'override:test',
      edited: true,
    })
    const added = custom.sections.find((s) => s.dataKey === 'refundPolicy2027')
    expect(added).toBeDefined()
    expect(added?.group).toBe('Custom')
    expect(added?.slug).toBe('refund-policy2027')
    expect(getKnowledgeSectionData(custom, 'refund-policy2027')).toEqual({
      summary: 'New policy',
    })
  })

  it('drops a manifest section whose key was removed in-app', () => {
    const data = { ...getKnowledgeData() }
    delete (data as Record<string, unknown>)['faq']
    const edited = buildKnowledgeStore({ data, version: 'override:t2', edited: true })
    expect(getKnowledgeSection(edited, 'faq')).toBeUndefined()
  })

  it('loadKnowledgeStore returns the baseline when no override row exists', async () => {
    const db = { knowledgeOverride: { findUnique: async () => null } }
    expect((await loadKnowledgeStore(db)).version).toBe('baseline')
  })

  it('loadKnowledgeStore returns the override and caches by updatedAt', async () => {
    const updatedAt = new Date('2026-06-17T10:00:00Z')
    let reads = 0
    const db = {
      knowledgeOverride: {
        findUnique: async () => {
          reads += 1
          return { data: { faq: [{ question: 'Q', answer: 'A' }] }, updatedAt }
        },
      },
    }
    const first = await loadKnowledgeStore(db)
    const second = await loadKnowledgeStore(db)
    expect(first.edited).toBe(true)
    expect(first.sections.map((s) => s.slug)).toEqual(['faq'])
    expect(second).toBe(first) // same built store, keyed on updatedAt
    expect(reads).toBe(2) // the row itself is always re-read (no stale data)
  })

  it('loadKnowledgeStore falls back to baseline on a malformed row', async () => {
    const db = {
      knowledgeOverride: {
        findUnique: async () => ({ data: 'not-an-object', updatedAt: new Date() }),
      },
    }
    expect((await loadKnowledgeStore(db)).version).toBe('baseline')
  })
})

describe('humaniseKey', () => {
  it('splits camelCase and capitalises the first word', () => {
    expect(humaniseKey('moneyBackGuarantee')).toBe('Money back guarantee')
    expect(humaniseKey('hourFlexibility')).toBe('Hour flexibility')
  })

  it('upper-cases known acronyms', () => {
    expect(humaniseKey('ucatNote')).toBe('UCAT note')
    expect(humaniseKey('faq')).toBe('FAQ')
    expect(humaniseKey('inPersonLondon')).toBe('In person london')
  })

  it('handles snake_case and kebab-case', () => {
    expect(humaniseKey('tutor_cost_note')).toBe('Tutor cost note')
    expect(humaniseKey('career-camps')).toBe('Career camps')
  })
})

describe('toRenderTree', () => {
  it('renders scalars as text', () => {
    expect(toRenderTree('hello')).toEqual({ kind: 'text', text: 'hello' })
    expect(toRenderTree(42)).toEqual({ kind: 'text', text: '42' })
    expect(toRenderTree(true)).toEqual({ kind: 'text', text: 'Yes' })
    expect(toRenderTree(null)).toEqual({ kind: 'text', text: '—' })
  })

  it('renders scalar arrays as lists', () => {
    expect(toRenderTree(['a', 'b'])).toEqual({
      kind: 'list',
      items: [
        { kind: 'text', text: 'a' },
        { kind: 'text', text: 'b' },
      ],
    })
  })

  it('renders arrays of flat objects as tables with humanised columns', () => {
    const node = toRenderTree([
      { tier: 'Bronze', hours: 60 },
      { tier: 'Silver', hours: 80 },
    ])
    expect(node).toEqual({
      kind: 'table',
      columns: ['Tier', 'Hours'],
      rows: [
        ['Bronze', '60'],
        ['Silver', '80'],
      ],
    })
  })

  it('prefers titled cards over tables when cells turn prose-length', () => {
    // e.g. common scenarios: {title, tone, guidance[]} — every value is
    // technically cell-able, but multi-step guidance squashed into one table
    // cell is unreadable. The cell-length guard pushes these to cards.
    const node = toRenderTree([
      { title: 'Scenario', tone: 'soft', guidance: ['x'.repeat(90), 'y'.repeat(90)] },
    ])
    expect(node.kind).toBe('cards')
  })

  it('falls back to titled cards for nested objects', () => {
    const node = toRenderTree([
      { name: 'Platinum', guarantee: { amount: '£500' } },
    ])
    expect(node.kind).toBe('cards')
    if (node.kind === 'cards') {
      expect(node.cards[0]?.title).toBe('Platinum')
      expect(node.cards[0]?.node.kind).toBe('entries')
    }
  })

  it('renders objects as labelled entries', () => {
    const node = toRenderTree({ salesPitch: 'Lead with flexibility' })
    expect(node).toEqual({
      kind: 'entries',
      entries: [
        { label: 'Sales pitch', node: { kind: 'text', text: 'Lead with flexibility' } },
      ],
    })
  })
})

describe('plain text rendering', () => {
  it('renders every section to non-empty text', () => {
    for (const section of KNOWLEDGE_SECTIONS) {
      expect(knowledgeSectionPlainText(store, section.slug).length, section.slug).toBeGreaterThan(0)
    }
  })

  it('keeps known facts intact', () => {
    const fullApplication = knowledgeSectionPlainText(store, 'full-application')
    expect(fullApplication).toContain('£500')
    expect(fullApplication.toLowerCase()).toContain('platinum')
  })

  it('includes the supplements (frontend scenarios + founders)', () => {
    expect(knowledgeSectionPlainText(store, 'common-scenarios')).toContain(
      'Anxious teen reluctant to engage',
    )
    const people = knowledgeSectionPlainText(store, 'people')
    expect(people).toContain('Mohil')
    expect(people).toContain('Kunal')
    expect(people).toContain('Becca') // the baseline list is still intact
  })

  it('serialises tables row by row', () => {
    const text = renderToPlainText({
      kind: 'table',
      columns: ['Tier', 'Hours'],
      rows: [['Bronze', '60']],
    })
    expect(text).toBe('- Tier: Bronze | Hours: 60')
  })
})

describe('searchKnowledge', () => {
  it('finds the Full Application guarantee', () => {
    const results = searchKnowledge(store, 'platinum money back guarantee')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.sectionSlug === 'full-application')).toBe(true)
  })

  it('finds shadowing partner practices', () => {
    const results = searchKnowledge(store, 'robin hood lane')
    expect(results.some((r) => r.sectionSlug === 'shadowing')).toBe(true)
  })

  it('finds the common call scenarios', () => {
    const results = searchKnowledge(store, 'anxious teen')
    expect(results.some((r) => r.sectionSlug === 'common-scenarios')).toBe(true)
  })

  it('searches edited content under its own store version', () => {
    const edited = buildKnowledgeStore({
      data: { faq: [{ question: 'Do you teach xylophonics tutoring?', answer: 'Yes' }] },
      version: 'override:search-test',
      edited: true,
    })
    const results = searchKnowledge(edited, 'xylophonics')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.sectionSlug).toBe('faq')
    // The baseline index is untouched.
    expect(searchKnowledge(store, 'xylophonics')).toEqual([])
  })

  it('returns nothing for an empty query', () => {
    expect(searchKnowledge(store, '   ')).toEqual([])
  })

  it('caps results at the limit', () => {
    expect(searchKnowledge(store, 'tutor', 5).length).toBeLessThanOrEqual(5)
  })
})

describe('buildKnowledgeContext', () => {
  it('includes the whole knowledge base at the default budget', () => {
    const ctx = buildKnowledgeContext(store, 'how many hours in the platinum package?')
    expect(ctx.truncated).toBe(false)
    expect(ctx.included.length).toBe(KNOWLEDGE_SECTIONS.length)
    const parsed = JSON.parse(ctx.contextJson) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(getKnowledgeData()).sort())
  })

  it('ranks the most relevant section first and surfaces it as related', () => {
    const ctx = buildKnowledgeContext(store, 'UCAT live day dates in Manchester')
    expect(ctx.related.length).toBeGreaterThan(0)
    expect(ctx.related.map((r) => r.slug)).toContain('live-days')
  })

  it('drops least-relevant sections under a small budget', () => {
    const ctx = buildKnowledgeContext(store, 'platinum money back guarantee', 30_000)
    expect(ctx.truncated).toBe(true)
    expect(ctx.included.length).toBeGreaterThan(0)
    expect(ctx.included.length).toBeLessThan(KNOWLEDGE_SECTIONS.length)
    expect(ctx.included.map((s) => s.slug)).toContain('full-application')
    // The context stays valid JSON even when truncated.
    expect(() => JSON.parse(ctx.contextJson)).not.toThrow()
  })

  it('grounds on in-app additions too', () => {
    const edited = buildKnowledgeStore({
      data: { ...getKnowledgeData(), winterRetreats: { summary: 'Ski + study retreat' } },
      version: 'override:ctx-test',
      edited: true,
    })
    const ctx = buildKnowledgeContext(edited, 'tell me about the winter retreats')
    const parsed = JSON.parse(ctx.contextJson) as Record<string, unknown>
    expect(parsed['winterRetreats']).toEqual({ summary: 'Ski + study retreat' })
    expect(ctx.related.map((r) => r.slug)).toContain('winter-retreats')
  })
})
