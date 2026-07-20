import { describe, expect, it } from 'vitest'

import { detectCampPurchase, keywordLabel, splitBillingName } from './purchase-detect'

describe('detectCampPurchase', () => {
  it('matches summer camp phrasing variants', () => {
    expect(detectCampPurchase('Medicine Summer Camp Week 1').keyword).toBe('summer_camp')
    expect(detectCampPurchase('SUMMER-CAMP deposit').keyword).toBe('summer_camp')
    expect(detectCampPurchase('summercamp 2026 oxford').keyword).toBe('summer_camp')
  })

  it('matches work experience phrasing variants', () => {
    expect(detectCampPurchase('Dentistry Work Experience').keyword).toBe('work_experience')
    expect(detectCampPurchase('work-experience week').keyword).toBe('work_experience')
    expect(detectCampPurchase('WorkExperience placement').keyword).toBe('work_experience')
  })

  it('summer camp wins when both phrases appear', () => {
    expect(detectCampPurchase('Summer Camp incl. work experience day').keyword).toBe('summer_camp')
  })

  it('never matches unrelated products or empty text', () => {
    expect(detectCampPurchase('UCAT tutoring bundle').matched).toBe(false)
    expect(detectCampPurchase('Boot camp fitness').matched).toBe(false)
    expect(detectCampPurchase('Experienced tutor session').matched).toBe(false)
    expect(detectCampPurchase('').matched).toBe(false)
    expect(detectCampPurchase(null).matched).toBe(false)
  })
})

describe('splitBillingName', () => {
  it('splits first + rest', () => {
    expect(splitBillingName('Jane Van Der Berg')).toEqual({ firstName: 'Jane', lastName: 'Van Der Berg' })
  })
  it('placeholder surname for single tokens; null for empty', () => {
    expect(splitBillingName('Cher')).toEqual({ firstName: 'Cher', lastName: '(unknown)' })
    expect(splitBillingName('  ')).toBeNull()
  })
})

describe('keywordLabel', () => {
  it('labels both families', () => {
    expect(keywordLabel('summer_camp')).toBe('Summer Camp')
    expect(keywordLabel('work_experience')).toBe('Work Experience')
  })
})
