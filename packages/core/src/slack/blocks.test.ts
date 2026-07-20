import { describe, expect, it } from 'vitest'

import {
  buildCallSummaryHeadline,
  buildCallSummarySlackBlocks,
  buildCallSummarySlackText,
  resolveButtonUrl,
} from './blocks'

describe('resolveButtonUrl', () => {
  it('substitutes the contactUrl placeholder', () => {
    expect(resolveButtonUrl('{{contactUrl}}#notes', 'https://crm.test/contacts/c1')).toBe(
      'https://crm.test/contacts/c1#notes',
    )
  })

  it('leaves urls without the placeholder untouched', () => {
    expect(resolveButtonUrl('https://other.test', 'https://crm.test/contacts/c1')).toBe(
      'https://other.test',
    )
  })
})

describe('buildCallSummaryHeadline', () => {
  it('drops missing identity parts and maps outcomes', () => {
    expect(buildCallSummaryHeadline({ contactName: 'Jane', outcome: 'voicemail' })).toBe(
      'Voicemail left — Jane',
    )
    expect(
      buildCallSummaryHeadline({ contactName: 'Jane', contactPhone: null, outcome: 'no_answer' }),
    ).toBe('No answer — Jane')
    expect(
      buildCallSummaryHeadline({
        contactName: 'Jane Smith',
        contactPhone: '+447700900123',
        contactEmail: 'jane@example.com',
        outcome: 'answered',
      }),
    ).toBe('Call completed — Jane Smith — +447700900123 — jane@example.com')
  })

  it('falls back to a generic verb when no outcome is given', () => {
    expect(buildCallSummaryHeadline({ contactName: 'Jane' })).toBe('Call summary — Jane')
  })
})

describe('buildCallSummarySlackBlocks', () => {
  const base = {
    contactName: 'Test Family A1',
    body: 'Spoke about UCAT prep.',
    contactUrl: 'https://crm.test/contacts/c1',
  }

  it('emits headline + divider + body when there are no buttons or author', () => {
    const blocks = buildCallSummarySlackBlocks({ ...base, buttons: [] }) as Array<{
      type: string
      text?: { text: string }
    }>
    expect(blocks).toHaveLength(3)
    expect(blocks[0]!.type).toBe('section')
    expect(blocks[0]!.text!.text).toBe('*📞 Call summary — Test Family A1*')
    expect(blocks[1]!.type).toBe('divider')
    expect(blocks[2]!.text!.text).toBe('Spoke about UCAT prep.')
  })

  it('renders the outcome — name — phone — email headline', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      buttons: [],
      contactPhone: '+447700900123',
      contactEmail: 'jane@example.com',
      outcome: 'answered',
    }) as Array<{ type: string; text?: { text: string } }>
    expect(blocks[0]!.text!.text).toBe(
      '*📞 Call completed — Test Family A1 — +447700900123 — jane@example.com*',
    )
  })

  it('appends a "logged by" context footer', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      buttons: [],
      authorName: 'Alex Agent',
    }) as Array<{ type: string; elements?: Array<{ text?: string }> }>
    const ctx = blocks[blocks.length - 1]!
    expect(ctx.type).toBe('context')
    expect(ctx.elements![0]!.text).toBe('Logged by Alex Agent')
  })

  it('appends an actions block with resolved button urls', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      buttons: [{ label: 'Open in CRM', url: '{{contactUrl}}' }],
    })
    expect(blocks[blocks.length - 1]).toMatchObject({
      type: 'actions',
      elements: [{ type: 'button', url: 'https://crm.test/contacts/c1' }],
    })
  })

  it('caps the actions block at 5 buttons', () => {
    const buttons = Array.from({ length: 8 }, (_, i) => ({
      label: `B${i}`,
      url: 'https://crm.test',
    }))
    const blocks = buildCallSummarySlackBlocks({ ...base, buttons })
    const actions = blocks[blocks.length - 1] as { elements: unknown[] }
    expect(actions.elements).toHaveLength(5)
  })
})

describe('buildCallSummarySlackText', () => {
  it('mirrors the headline + body + contact url', () => {
    const text = buildCallSummarySlackText({
      contactName: 'Jane Smith',
      body: 'Discussed UCAT prep.',
      contactUrl: 'https://crm.example/contacts/c1',
      buttons: [],
      outcome: 'answered',
    })
    expect(text).toContain('Call completed — Jane Smith')
    expect(text).toContain('Discussed UCAT prep.')
    expect(text).toContain('https://crm.example/contacts/c1')
  })
})
