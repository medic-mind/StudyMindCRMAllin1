// Pure-logic tests for the WhatsApp template helpers in outbound.ts.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@studymind/db', () => ({ db: {} }))

import { extractWaTemplateParams } from './outbound'

describe('extractWaTemplateParams', () => {
  it('finds {{n}} placeholders in order, deduped', () => {
    expect(
      extractWaTemplateParams('Hi {{1}}, your {{2}} pack is here. Bye {{1}}.'),
    ).toEqual(['{{1}}', '{{2}}'])
  })

  it('tolerates whitespace inside the braces', () => {
    expect(extractWaTemplateParams('Hi {{ 1 }} and {{2 }}')).toEqual(['{{1}}', '{{2}}'])
  })

  it('returns empty for a template without params', () => {
    expect(extractWaTemplateParams('Static message, no fields.')).toEqual([])
  })

  it('ignores name-style placeholders (quick replies use those, not HSMs)', () => {
    expect(extractWaTemplateParams('Hi {{first_name}}')).toEqual([])
  })
})
