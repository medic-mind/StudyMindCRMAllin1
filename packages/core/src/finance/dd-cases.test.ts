// Pure transition logic for Direct Debit recovery cases (ADR 0038).

import { describe, expect, it } from 'vitest'

import { canTransition, isClosedStatus } from './dd-cases'

describe('canTransition', () => {
  it('walks the open flow new → chasing → escalated', () => {
    expect(canTransition('new', 'chasing')).toBe(true)
    expect(canTransition('chasing', 'escalated')).toBe(true)
    expect(canTransition('escalated', 'chasing')).toBe(true)
  })

  it('allows closing from any open state', () => {
    for (const from of ['new', 'chasing', 'escalated'] as const) {
      expect(canTransition(from, 'recovered')).toBe(true)
      expect(canTransition(from, 'written_off')).toBe(true)
    }
  })

  it('allows reopening a closed case back to chasing', () => {
    expect(canTransition('recovered', 'chasing')).toBe(true)
    expect(canTransition('written_off', 'chasing')).toBe(true)
  })

  it('rejects no-op and illegal moves', () => {
    expect(canTransition('chasing', 'chasing')).toBe(false)
    expect(canTransition('recovered', 'written_off')).toBe(false)
    expect(canTransition('recovered', 'escalated')).toBe(false)
    expect(canTransition('new', 'new')).toBe(false)
  })
})

describe('isClosedStatus', () => {
  it('treats recovered and written_off as closed', () => {
    expect(isClosedStatus('recovered')).toBe(true)
    expect(isClosedStatus('written_off')).toBe(true)
    expect(isClosedStatus('new')).toBe(false)
    expect(isClosedStatus('chasing')).toBe(false)
    expect(isClosedStatus('escalated')).toBe(false)
  })
})
