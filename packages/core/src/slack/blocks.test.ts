import { describe, expect, it } from 'vitest'

import {
  buildCallSummaryHeadline,
  buildCallSummarySlackBlocks,
  buildCallSummarySlackText,
  resolveButtonUrl,
} from './blocks'

describe('resolveButtonUrl', () => {
  it('substitutes the contactUrl placeholder', () => {
    expect(resolveButtonUrl('{{contactUrl}}#tasks', 'https://crm.test/contacts/c1')).toBe(
      'https://crm.test/contacts/c1#tasks',
    )
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
    expect(buildCallSummaryHeadline({ contactName: 'Jane', outcome: 'voicemail' })).toBe(
      'Voicemail left — Jane',
    )
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

describe('buildCallSummarySlackBlocks — disposition layout (ADR 0039 amendment)', () => {
  const base = {
    contactName: 'Jane Smith',
    body: 'Discussed UCAT prep and pricing.',
    contactUrl: 'https://crm.example/contacts/c1',
    buttons: [],
    contactPhone: '+447700900123',
    contactEmail: 'jane@example.com',
    outcome: 'answered' as const,
  }

  it('sent_to_customer: states the sales team already sent it + the channels used', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      disposition: 'sent_to_customer',
      sentChannels: ['Email', 'WhatsApp'],
    }) as Array<{ type: string; text?: { text: string } }>

    expect(blocks[0]!.text!.text).toBe('*✅ Call summary — ALREADY SENT to the customer*')
    expect(blocks[1]!.text!.text).toBe(
      'Call completed — Jane Smith — +447700900123 — jane@example.com',
    )
    expect(blocks[2]!.type).toBe('divider')
    // The "awfully clear it's been done" banner naming the channels.
    const banner = blocks[4]!.text!.text
    expect(banner).toContain('The sales team has already sent this call summary')
    expect(banner).toContain('(Email, WhatsApp)')
  })

  it('sent_to_customer: surfaces any outstanding follow-up tasks', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      disposition: 'sent_to_customer',
      sentChannels: ['Email'],
      followUps: [{ title: 'Book trial lesson', dueAt: '2026-06-20', assignee: 'Sales team' }],
    }) as Array<{ type: string; text?: { text: string } }>
    const followUp = blocks[5]!.text!.text
    expect(followUp).toContain('Follow-up task')
    expect(followUp).toContain('• Book trial lesson')
    expect(followUp).toContain('(due 20 Jun 2026)')
    expect(followUp).toContain('Sales team')
  })

  it('va_handoff: makes VA action + assignee unmistakable', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      disposition: 'va_handoff',
      handoffAssignee: 'VA team',
      followUps: [{ title: 'Send call summary: Jane Smith' }],
    }) as Array<{ type: string; text?: { text: string } }>

    expect(blocks[0]!.text!.text).toBe('*🚨 Call summary — ACTION REQUIRED from the VA team*')
    const banner = blocks[4]!.text!.text
    expect(banner).toContain('VA team — please action this')
    expect(banner).toContain('cleared on the CRM')
    expect(banner).toContain('*Assigned to:* VA team')
  })

  it('logged: says nothing was sent to the customer', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      disposition: 'logged',
    }) as Array<{ type: string; text?: { text: string } }>
    expect(blocks[0]!.text!.text).toBe('*📝 Call summary — logged on the CRM*')
    expect(blocks[4]!.text!.text).toContain('no customer message was sent')
  })

  it('appends an author footer + still appends action buttons', () => {
    const blocks = buildCallSummarySlackBlocks({
      ...base,
      disposition: 'sent_to_customer',
      sentChannels: ['Email'],
      authorName: 'Alex Agent',
      buttons: [{ label: 'Open in CRM', url: '{{contactUrl}}' }],
    }) as Array<{ type: string; elements?: Array<{ text?: string; url?: string }> }>
    const ctx = blocks[blocks.length - 2]!
    expect(ctx.type).toBe('context')
    expect(ctx.elements![0]!.text).toBe('Logged by Alex Agent')
    const actions = blocks[blocks.length - 1]!
    expect(actions.type).toBe('actions')
    expect(actions.elements![0]!.url).toBe('https://crm.example/contacts/c1')
  })

  it('text fallback mirrors the disposition headline + banner', () => {
    const text = buildCallSummarySlackText({
      ...base,
      disposition: 'va_handoff',
      handoffAssignee: 'VA team',
    })
    expect(text).toContain('🚨 Call summary — ACTION REQUIRED from the VA team')
    expect(text).toContain('VA team — please action this')
    expect(text).toContain('https://crm.example/contacts/c1')
  })
})
