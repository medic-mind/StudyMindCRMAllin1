// Board input schema tests (ADR 0018).

import { describe, expect, it } from 'vitest'

import {
  BoardCreateInput,
  CardCreateInput,
  LabelCreateInput,
  SubjectCreateInput,
} from './types'

describe('BoardCreateInput', () => {
  it('accepts a named board and defaults isDefault to false', () => {
    const parsed = BoardCreateInput.parse({ name: 'Summer Camp' })
    expect(parsed.isDefault).toBe(false)
  })

  it('rejects an empty name', () => {
    expect(() => BoardCreateInput.parse({ name: '   ' })).toThrow()
  })
})

describe('CardCreateInput', () => {
  it('accepts a card linking an existing contact', () => {
    const parsed = CardCreateInput.parse({
      boardId: 'b1',
      stageId: 's1',
      contact: { contactId: 'c1' },
    })
    expect('contactId' in parsed.contact && parsed.contact.contactId).toBe('c1')
  })

  it('accepts a card that creates a new contact', () => {
    const parsed = CardCreateInput.parse({
      boardId: 'b1',
      stageId: 's1',
      contact: { contact: { kind: 'parent', firstName: 'Test', lastName: 'Family' } },
      labelIds: ['l1', 'l2'],
    })
    expect('contact' in parsed.contact).toBe(true)
    expect(parsed.labelIds).toEqual(['l1', 'l2'])
  })

  it('rejects a card with neither contact form', () => {
    expect(() =>
      CardCreateInput.parse({ boardId: 'b1', stageId: 's1', contact: {} }),
    ).toThrow()
  })
})

describe('LabelCreateInput', () => {
  it('requires name and colour', () => {
    expect(LabelCreateInput.parse({ name: 'B2C', color: 'blue-600' })).toEqual({
      name: 'B2C',
      color: 'blue-600',
    })
    expect(() => LabelCreateInput.parse({ name: 'B2C' })).toThrow()
  })
})

describe('SubjectCreateInput', () => {
  it('trims and requires a name', () => {
    expect(SubjectCreateInput.parse({ name: '  Maths ' })).toEqual({ name: 'Maths' })
    expect(() => SubjectCreateInput.parse({ name: '' })).toThrow()
  })
})
