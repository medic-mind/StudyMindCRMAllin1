import { describe, expect, it } from 'vitest'

import { renderTemplate } from './templates'
import type { ForwardingTemplateContext } from './types'

const ctx: ForwardingTemplateContext = {
  contactName: 'Jane Doe',
  contactEmail: 'jane@example.com',
  contactPhone: '+447700900123',
  contactId: 'c1',
  contactLink: 'https://crm.studymind.co.uk/contacts/c1',
  familyName: 'Doe Family',
  agentName: 'Alex Agent',
  agentEmail: 'alex@studymind.co.uk',
  notes: 'Could the AP team have a look at this query?',
}

describe('renderTemplate', () => {
  it('substitutes all known variables', () => {
    const out = renderTemplate(
      'Hi, please look at {{contactName}} ({{contactEmail}}) — {{notes}}',
      ctx,
    )
    expect(out).toBe(
      'Hi, please look at Jane Doe (jane@example.com) — Could the AP team have a look at this query?',
    )
  })

  it('renders an empty string for unknown variables (no leak)', () => {
    expect(renderTemplate('A {{nope}} B', ctx)).toBe('A  B')
  })

  it('preserves unescaped single-brace text', () => {
    expect(renderTemplate('Has {one} brace and {{contactName}}', ctx)).toBe(
      'Has {one} brace and Jane Doe',
    )
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{ contactName }} - {{   contactEmail}}', ctx)).toBe(
      'Jane Doe - jane@example.com',
    )
  })

  it('renders an empty value for missing context fields', () => {
    const partial: ForwardingTemplateContext = { ...ctx, contactPhone: '' }
    expect(renderTemplate('Phone: {{contactPhone}}.', partial)).toBe('Phone: .')
  })
})
