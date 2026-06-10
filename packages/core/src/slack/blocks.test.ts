import { describe, expect, it } from 'vitest'

import { buildCallSummaryHeadline, buildCallSummarySlackBlocks, resolveButtonUrl } from './blocks'

describe('resolveButtonUrl', () => {
  it('substitutes the contactUrl placeholder', () => {
    expect(
      resolveButtonUrl('{{contactUrl}}#tasks', 'https://crm.test/contacts/c1'),
    ).toBe('https://crm.test/contacts/c1#tasks')
  })

  it('leaves urls without the placeholder untouched', () => {
    expect(resolveButtonUrl('https://other.test', 'https://crm.test/contacts/c1')).toBe(
      'https://other.test',
    )
  })
})

describe('buildCallSummarySlackBlocks', () => {
  const base = {
    contactName: 'Test Family A1',
    body: 'Spoke about UCAT prep.',
    contactUrl: 'https://crm.test/contacts/c1',
  }

  it('emits a single section block when there are no buttons', () => {
    const blocks = buildCallSummarySlackBlocks({ ...base, buttons: [] })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'section' })
  })

  it('appends an actions block with resolved button urls', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      buttons: [{ label: 'Open in CRM', url: '{{contactUrl}}' }],
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({
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
    const actions = blocks[1] as { elements: unknown[] }
    expect(actions.elements).toHaveLength(5)
  })
})

describe('buildCallSummarySlackBlocks — VA internal-note layout', () => {
  it('renders the outcome — name — phone — email headline + pending tasks section', () => {
    const blocks = buildCallSummarySlackBlocks({
      contactName: 'Jane Smith',
      body: '- Send the UCAT pack\n- Chase payment',
      contactUrl: 'https://crm.example/contacts/c1',
      buttons: [],
      contactPhone: '+447700900123',
      contactEmail: 'jane@example.com',
      outcome: 'answered',
      variant: 'internal_note',
    }) as Array<{ type: string; text?: { text: string } }>

    expect(blocks[0]!.text!.text).toBe(
      '*Call completed — Jane Smith — +447700900123 — jane@example.com*',
    )
    expect(blocks[1]!.type).toBe('divider')
    expect(blocks[2]!.text!.text).toContain('*Pending tasks for VA team*')
    expect(blocks[2]!.text!.text).toContain('- Send the UCAT pack')
  })

  it('drops missing identity parts from the headline and maps outcomes', () => {
    expect(
      buildCallSummaryHeadline({ contactName: 'Jane', outcome: 'voicemail' }),
    ).toBe('Voicemail left — Jane')
    expect(
      buildCallSummaryHeadline({ contactName: 'Jane', contactPhone: null, outcome: 'no_answer' }),
    ).toBe('No answer — Jane')
  })

  it('keeps the classic layout for the summary variant', () => {
    const blocks = buildCallSummarySlackBlocks({
      contactName: 'Jane Smith',
      body: 'Spoke about UCAT.',
      contactUrl: 'https://crm.example/contacts/c1',
      buttons: [],
    }) as Array<{ type: string; text?: { text: string } }>
    expect(blocks[0]!.text!.text).toContain('*Call summary — Jane Smith*')
  })
})
