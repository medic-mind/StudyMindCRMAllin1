import { describe, expect, it } from 'vitest'

import { buildCallSummarySlackBlocks, resolveButtonUrl } from './blocks'

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
