// Tests for the contact-field suggestion diff helper. ADR 0020 Phase 6c.

import { describe, expect, it } from 'vitest'

import {
  buildContactSuggestionWrites,
  type ContactSnapshot,
} from './contact-suggestions'

const baseline: ContactSnapshot = {
  id: 'c_1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phoneE164: '+447700900001',
}

function pick<T extends { field: string }>(
  writes: T[],
  field: string,
): T | undefined {
  return writes.find((w) => w.field === field)
}

describe('buildContactSuggestionWrites', () => {
  it('returns nothing when the proposal matches the current contact', () => {
    const writes = buildContactSuggestionWrites({
      current: baseline,
      proposal: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+447700900001' },
      sourceEventId: 'evt_1',
    })
    expect(writes).toEqual([])
  })

  it('proposes only the fields that differ — lowercased email', () => {
    const writes = buildContactSuggestionWrites({
      current: baseline,
      proposal: { email: 'ADA-NEW@example.com' },
      sourceEventId: 'evt_email',
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      field: 'email',
      proposedValue: 'ada-new@example.com',
      currentValue: 'ada@example.com',
      contactId: 'c_1',
      source: 'trengo',
      sourceEventId: 'evt_email',
    })
    expect(writes[0]!.id).toBeTruthy()
  })

  it('drops a bare local phone proposal rather than guessing E.164', () => {
    const writes = buildContactSuggestionWrites({
      current: baseline,
      proposal: { phone: '07700900002' }, // missing +
      sourceEventId: 'evt_phone',
    })
    expect(pick(writes, 'phoneE164')).toBeUndefined()
  })

  it('accepts an E.164 phone proposal and records the current value', () => {
    const writes = buildContactSuggestionWrites({
      current: baseline,
      proposal: { phone: '+447700900099' },
      sourceEventId: 'evt_phone',
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]!.field).toBe('phoneE164')
    expect(writes[0]!.proposedValue).toBe('+447700900099')
    expect(writes[0]!.currentValue).toBe('+447700900001')
  })

  it('splits a two-word name into firstName + lastName proposals', () => {
    const writes = buildContactSuggestionWrites({
      current: { ...baseline, firstName: 'Ada', lastName: 'Byron' },
      proposal: { name: 'Ada Lovelace' },
      sourceEventId: 'evt_name',
    })
    expect(pick(writes, 'firstName')).toBeUndefined() // matches current
    expect(pick(writes, 'lastName')?.proposedValue).toBe('Lovelace')
    expect(pick(writes, 'lastName')?.currentValue).toBe('Byron')
  })

  it('treats a single-token name as a firstName-only proposal', () => {
    const writes = buildContactSuggestionWrites({
      current: { ...baseline, firstName: null, lastName: 'Lovelace' },
      proposal: { name: 'Ada' },
      sourceEventId: 'evt_name_solo',
    })
    expect(pick(writes, 'firstName')?.proposedValue).toBe('Ada')
    // Last name proposal MUST be null (not "no proposal") because the
    // helper returns `{firstName, lastName: null}` for a single token —
    // and the existing lastName 'Lovelace' differs from null. Verify the
    // write IS emitted so reviewers can choose whether to clear.
    const last = pick(writes, 'lastName')
    expect(last?.proposedValue).toBeNull()
    expect(last?.currentValue).toBe('Lovelace')
  })

  it('treats explicit empty strings as "clear this field" proposals', () => {
    const writes = buildContactSuggestionWrites({
      current: baseline,
      proposal: { email: '', phone: '' },
      sourceEventId: 'evt_clear',
    })
    expect(pick(writes, 'email')?.proposedValue).toBeNull()
    expect(pick(writes, 'phoneE164')?.proposedValue).toBeNull()
  })

  it('treats missing keys as "no proposal on this field"', () => {
    const writes = buildContactSuggestionWrites({
      current: baseline,
      // Empty object — webhook didn't touch any field.
      proposal: {},
      sourceEventId: 'evt_empty',
    })
    expect(writes).toEqual([])
  })
})
