import { describe, expect, it } from 'vitest'

import {
  isOnInstalments,
  isPartialPaymentType,
  instalmentState,
  parseCsvRows,
  parseDepositFromNotes,
  parseInstalmentCsv,
  parseMoneyToMinor,
  remainingMinor,
  summariseInstalments,
} from './instalments'

describe('parseCsvRows (RFC 4180)', () => {
  it('handles quoted fields with embedded commas AND newlines', () => {
    const csv = 'a,b,c\n1,"hello, world","line1\nline2"\n2,x,y\n'
    const rows = parseCsvRows(csv)
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', 'hello, world', 'line1\nline2'],
      ['2', 'x', 'y'],
    ])
  })

  it('handles escaped double-quotes and a final row without trailing newline', () => {
    const rows = parseCsvRows('h\n"say ""hi"""')
    expect(rows).toEqual([['h'], ['say "hi"']])
  })
})

describe('parseMoneyToMinor', () => {
  it('parses £, commas and decimals into pence; blanks → 0', () => {
    expect(parseMoneyToMinor('£2,999.50')).toBe(299950)
    expect(parseMoneyToMinor('2999')).toBe(299900)
    expect(parseMoneyToMinor('')).toBe(0)
    expect(parseMoneyToMinor(null)).toBe(0)
  })
})

describe('parseDepositFromNotes', () => {
  it('pulls the deposit out of free-text notes', () => {
    expect(parseDepositFromNotes('Paid Initial £500')).toEqual({ value: 50000, labelled: true })
    expect(parseDepositFromNotes('deposit £750 received')).toEqual({ value: 75000, labelled: true })
    // A bare £ figure with no deposit label is reported as unlabelled — the
    // caller only trusts it for a part-payment booking.
    expect(parseDepositFromNotes('Availed of our Research Program £500')).toEqual({
      value: 50000,
      labelled: false,
    })
    expect(parseDepositFromNotes('no money here')).toBeNull()
    expect(parseDepositFromNotes(null)).toBeNull()
  })
})

describe('isPartialPaymentType', () => {
  it('flags instalment / initial-deposit, not full-payment methods', () => {
    expect(isPartialPaymentType('Installment')).toBe(true)
    expect(isPartialPaymentType('Initial Deposit')).toBe(true)
    expect(isPartialPaymentType('Stripe')).toBe(false)
    expect(isPartialPaymentType('Bank Deposit')).toBe(false)
    expect(isPartialPaymentType(null)).toBe(false)
  })
})

describe('remaining + state', () => {
  it('derives remaining and never goes negative', () => {
    expect(remainingMinor(299900, 50000)).toBe(249900)
    expect(remainingMinor(299900, 299900)).toBe(0)
    expect(remainingMinor(50000, 80000)).toBe(0)
  })
  it('labels the state', () => {
    expect(instalmentState(299900, 50000)).toBe('deposit_paid')
    expect(instalmentState(299900, 299900)).toBe('paid')
    expect(instalmentState(299900, 0)).toBe('unpaid')
  })
})

const HEADER =
  'Int,Type,Date of Payment,Subject,Name of Student,Email Address,Mobile Number,Guardian Name,G-Email Address,G-Mobile Number,Payment Type,Amount Paid (£),Accom Fee (£),Extra Night (£),Airport Transfer,No of Days Booked,Week,Type ,With Accommodation,With Transfer Service,Check In Date (Start Sunday),Check Out Date (Friday Morning),Status,Agent,Notes:,Filled Out Intake form,Encoded By:,Online Research Program £500'

describe('parseInstalmentCsv', () => {
  it('maps an instalment booking and computes the £500 deposit from notes', () => {
    const csv = `${HEADER}\n2,B2C,10/26/2025,"Law, Criminology",Kyla Oliver,kyla@example.com,+352661441408,Dr Scott Oliver,scott@example.com,352691871763,Installment,2999,,,,10,"Wk 5, Wk 6",Multiple Weeks,FALSE,FALSE,,,Confirmed,,Paid Initial £500,Yes,Minette,\n`
    const rows = parseInstalmentCsv(csv)
    expect(rows).toHaveLength(1)
    const b = rows[0]!
    expect(b.studentName).toBe('Kyla Oliver')
    expect(b.studentEmail).toBe('kyla@example.com')
    expect(b.paymentType).toBe('Installment')
    expect(b.subject).toBe('Law, Criminology')
    expect(b.totalDueMinor).toBe(299900)
    expect(b.depositPaidMinor).toBe(50000)
    expect(remainingMinor(b.totalDueMinor, b.depositPaidMinor)).toBe(249900)
    expect(isOnInstalments(b)).toBe(true)
    expect(b.dedupeKey).toContain('kyla@example.com')
  })

  it('treats a full-payment method as settled (deposit = total)', () => {
    const csv = `${HEADER}\n5,Agent,1/14/2026,Medicine,Katy Qin,katy@example.com,,,,,Stripe,3749,,,,15,Wk 3,Multiple Weeks,FALSE,FALSE,,,Confirmed,Polly,paid in full,Yes,Polly,\n`
    const b = parseInstalmentCsv(csv)[0]!
    expect(b.totalDueMinor).toBe(374900)
    expect(b.depositPaidMinor).toBe(374900)
    expect(remainingMinor(b.totalDueMinor, b.depositPaidMinor)).toBe(0)
    expect(isOnInstalments(b)).toBe(false)
  })

  it('initial-deposit with no stated deposit defaults to £500 remaining', () => {
    const csv = `${HEADER}\n13,B2C,1/20/2026,Law,Alex Bryant,alex@example.com,447525616556,Anna Bryant,anna@example.com,447899024262,Initial Deposit,1699,,,,5,Wk 3,One Week only,FALSE,FALSE,,,Confirmed,,,Yes,Minette,\n`
    const b = parseInstalmentCsv(csv)[0]!
    expect(b.depositPaidMinor).toBe(50000)
    expect(remainingMinor(b.totalDueMinor, b.depositPaidMinor)).toBe(119900)
  })

  it('skips blank/separator rows and dedupes a re-import to the same key', () => {
    const line = `2,B2C,10/26/2025,Law,Kyla Oliver,kyla@example.com,,,,,Installment,2999,,,,10,Wk 5,Multiple Weeks,FALSE,FALSE,,,Confirmed,,Paid Initial £500,Yes,Minette,`
    const csv = `${HEADER}\n${line}\n,,,,,,,,,,,,,,,,,,,,,,,,,,,\n${line}\n`
    const rows = parseInstalmentCsv(csv)
    expect(rows).toHaveLength(2) // both data rows parsed; same dedupeKey
    expect(rows[0]!.dedupeKey).toBe(rows[1]!.dedupeKey)
  })

  it('summarises totals + the on-instalments cohort', () => {
    const s = summariseInstalments([
      { paymentType: 'Installment', totalDueMinor: 299900, depositPaidMinor: 50000 },
      { paymentType: 'Stripe', totalDueMinor: 374900, depositPaidMinor: 374900 },
    ])
    expect(s).toEqual({
      count: 2,
      onInstalments: 1,
      totalDueMinor: 674800,
      totalDepositMinor: 424900,
      totalOutstandingMinor: 249900,
    })
  })
})
