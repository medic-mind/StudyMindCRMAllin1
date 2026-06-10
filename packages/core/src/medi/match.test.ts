import { describe, expect, it } from 'vitest'

import { decideMediMatch, type MediContactCandidate } from './match'

const candidate = (over: Partial<MediContactCandidate> & { id: string }): MediContactCandidate => ({
  firstName: null,
  lastName: null,
  email: null,
  phoneE164: null,
  ...over,
})

describe('decideMediMatch', () => {
  it('reuses a single email match', () => {
    const decision = decideMediMatch({
      email: 'a@example.com',
      phoneE164: '+447700900123',
      byEmail: [candidate({ id: 'c1', email: 'a@example.com' })],
      byPhone: [],
    })
    expect(decision).toEqual({ kind: 'reuse', contactId: 'c1', matchedBy: 'email', ambiguous: false })
  })

  it('reuses the oldest of multiple email matches and flags ambiguity', () => {
    const decision = decideMediMatch({
      email: 'a@example.com',
      phoneE164: null,
      byEmail: [
        candidate({ id: 'oldest', email: 'a@example.com' }),
        candidate({ id: 'dupe', email: 'a@example.com' }),
      ],
      byPhone: [],
    })
    expect(decision).toEqual({ kind: 'reuse', contactId: 'oldest', matchedBy: 'email', ambiguous: true })
  })

  it('adopts a single phone match when the contact has no email', () => {
    const decision = decideMediMatch({
      email: 'new@example.com',
      phoneE164: '+447700900123',
      byEmail: [],
      byPhone: [candidate({ id: 'p1', email: null, phoneE164: '+447700900123' })],
    })
    expect(decision).toEqual({ kind: 'reuse', contactId: 'p1', matchedBy: 'phone', ambiguous: false })
  })

  it('adopts a single phone match when the email is the same', () => {
    const decision = decideMediMatch({
      email: 'same@example.com',
      phoneE164: '+447700900123',
      byEmail: [],
      byPhone: [candidate({ id: 'p1', email: 'SAME@example.com', phoneE164: '+447700900123' })],
    })
    expect(decision.kind).toBe('reuse')
  })

  it('creates rather than adopt a phone that belongs to a different email', () => {
    const decision = decideMediMatch({
      email: 'student@example.com',
      phoneE164: '+447700900123',
      byEmail: [],
      byPhone: [candidate({ id: 'parent', email: 'parent@example.com', phoneE164: '+447700900123' })],
    })
    expect(decision).toEqual({ kind: 'create' })
  })

  it('creates when a shared line matches more than one contact', () => {
    const decision = decideMediMatch({
      email: 'new@example.com',
      phoneE164: '+447700900123',
      byEmail: [],
      byPhone: [
        candidate({ id: 'a', phoneE164: '+447700900123' }),
        candidate({ id: 'b', phoneE164: '+447700900123' }),
      ],
    })
    expect(decision).toEqual({ kind: 'create' })
  })

  it('creates when nothing matches', () => {
    const decision = decideMediMatch({
      email: 'new@example.com',
      phoneE164: '+447700900999',
      byEmail: [],
      byPhone: [],
    })
    expect(decision).toEqual({ kind: 'create' })
  })
})
