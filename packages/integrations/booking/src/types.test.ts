// Mapper unit tests (ADR 0029). Normalisation + fail-closed on the one true
// enum (credit kind). Fixtures are sanitised synthetic data (CLAUDE.md §23.1).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  mapCreditKind,
  mapCreditTransaction,
  mapHoursTransaction,
  mapLesson,
  mapStudent,
  normaliseEnumString,
  splitFullName,
  type RawBalanceTransaction,
  type RawCreditTransaction,
  type RawLesson,
  type RawStudent,
} from './types'

function loadFixture<T>(name: string): { data: T[] } {
  const path = resolve(process.cwd(), '__tests__/fixtures/booking', name)
  return JSON.parse(readFileSync(path, 'utf8')) as { data: T[] }
}

describe('normaliseEnumString', () => {
  it('lowercases and collapses spaces/hyphens to underscores', () => {
    expect(normaliseEnumString('No Fee')).toBe('no_fee')
    expect(normaliseEnumString('Automated - Essay Submission')).toBe('automated_essay_submission')
    expect(normaliseEnumString('  UCAT ')).toBe('ucat')
  })
})

describe('splitFullName', () => {
  it('splits first + rest', () => {
    expect(splitFullName('Test Student A1')).toEqual({ firstName: 'Test', lastName: 'Student A1' })
    expect(splitFullName('Solo')).toEqual({ firstName: 'Solo', lastName: null })
    expect(splitFullName('')).toEqual({ firstName: null, lastName: null })
    expect(splitFullName(null)).toEqual({ firstName: null, lastName: null })
  })
})

describe('mapStudent', () => {
  const raw = loadFixture<RawStudent>('students.json').data[0]!

  it('maps identity, guardian, balance and credits', () => {
    const s = mapStudent(raw)
    expect(s.uuid).toBe('00000000-0000-4000-8000-000000000005')
    expect(s.legacyId).toBe(5)
    expect(s.firstName).toBe('Test')
    expect(s.lastName).toBe('Student A1')
    expect(s.phoneE164).toBe('+447000000005')
    expect(s.hasGuardian).toBe(true)
    expect(s.guardianName).toBe('Test Guardian A')
    expect(s.balance.hoursAdded).toBe(46)
    expect(s.balance.hoursRemaining).toBe(0)
    expect(s.credits.onlineMmi).toBe(2)
    expect(s.credits.liveDay).toBe(1)
    expect(s.labels).toEqual(['ucat', 'priority'])
    expect(s.dateOfBirth?.toISOString()).toBe('2010-09-01T00:00:00.000Z')
  })

  it('prefers split names when given, else splits full_name', () => {
    const withSplit = mapStudent({ ...raw, first_name: 'Given', last_name: 'Family' })
    expect(withSplit.firstName).toBe('Given')
    expect(withSplit.lastName).toBe('Family')
  })

  it('defaults a missing balance/credits block to zeros', () => {
    const bare = mapStudent({ ...raw, balance: null, credits: null })
    expect(bare.balance.hoursAdded).toBe(0)
    expect(bare.credits.onlineMmi).toBe(0)
  })
})

describe('mapLesson', () => {
  it('normalises status/payment/subject and derives duration', () => {
    const raw = loadFixture<RawLesson>('lessons.json').data[0]!
    const l = mapLesson(raw)
    expect(l.externalId).toBe('203437')
    expect(l.status).toBe('cancelled')
    expect(l.payment).toBe('no_fee')
    expect(l.subject).toBe('ucat')
    expect(l.durationMinutes).toBe(60)
    expect(l.trialFeedbackStatus).toBe('pending')
  })

  it('handles a deleted tutor and a charged lesson', () => {
    const raw = loadFixture<RawLesson>('lessons.json').data[1]!
    const l = mapLesson(raw)
    expect(l.tutorExternalId).toBeNull()
    expect(l.tutorName).toBe('[Deleted Tutor]')
    expect(l.status).toBe('active')
    expect(l.payment).toBe('charged')
  })
})

describe('mapHoursTransaction', () => {
  it('maps signed hours, pence, expiry and normalises type', () => {
    const [added, used] = loadFixture<RawBalanceTransaction>('balance-transactions.json').data
    const a = mapHoursTransaction(added!)
    expect(a.hours).toBe(5)
    expect(a.amountMinor).toBe(25000)
    expect(a.stripeReference).toBe('aeuihf78')
    expect(a.expiresAt?.toISOString()).toBe('2022-02-13T01:09:00.000Z')
    expect(a.type).toBe('purchase')

    const u = mapHoursTransaction(used!)
    expect(u.hours).toBe(-1)
    expect(u.amountMinor).toBeNull()
    expect(u.isPremium).toBe(false)
    expect(u.type).toBe('automated_essay_submission')
  })
})

describe('mapCreditKind', () => {
  it('maps the four known kinds', () => {
    expect(mapCreditKind('Online MMI')).toBe('online_mmi')
    expect(mapCreditKind('in_person_live_day')).toBe('in_person_live_day')
  })

  it('fails closed on an unknown kind', () => {
    expect(() => mapCreditKind('mystery_pack')).toThrow(/Unknown booking credit kind/)
  })
})

describe('mapCreditTransaction', () => {
  it('maps the fixture row', () => {
    const raw = loadFixture<RawCreditTransaction>('credit-transactions.json').data[0]!
    const c = mapCreditTransaction(raw)
    expect(c.externalId).toBe('ct_1')
    expect(c.creditKind).toBe('online_mmi')
    expect(c.credits).toBe(2)
    expect(c.amountMinor).toBe(5000)
  })
})
