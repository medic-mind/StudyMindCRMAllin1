import { describe, expect, it } from 'vitest'

import {
  buildTimetablePlan,
  minuteToTimeLabel,
  parseStartMinute,
  resolveCatalogueHandle,
  toWebinarHandle,
  weekdayToIndex,
  type CatalogueOption,
  type TimetableImportAiShape,
} from './timetable'

describe('toWebinarHandle', () => {
  it('matches the catalogue router normalisation', () => {
    expect(toWebinarHandle('A-Level')).toBe('a_level')
    expect(toWebinarHandle('English Language')).toBe('english_language')
    expect(toWebinarHandle('  UCAT  ')).toBe('ucat')
  })
})

describe('weekdayToIndex', () => {
  it('parses full and short names (Mon=0..Sun=6)', () => {
    expect(weekdayToIndex('Monday')).toBe(0)
    expect(weekdayToIndex('tue')).toBe(1)
    expect(weekdayToIndex('Weds')).toBe(2)
    expect(weekdayToIndex('SUNDAY')).toBe(6)
  })
  it('returns null for nonsense', () => {
    expect(weekdayToIndex('someday')).toBeNull()
    expect(weekdayToIndex('')).toBeNull()
  })
})

describe('parseStartMinute', () => {
  it('parses 24h and 12h clock', () => {
    expect(parseStartMinute('18:00')).toBe(1080)
    expect(parseStartMinute('9:30')).toBe(570)
    expect(parseStartMinute('6:30pm')).toBe(1110)
    expect(parseStartMinute('9am')).toBe(540)
    expect(parseStartMinute('12am')).toBe(0)
    expect(parseStartMinute('12pm')).toBe(720)
  })
  it('rejects bad input', () => {
    expect(parseStartMinute('25:00')).toBeNull()
    expect(parseStartMinute('half six')).toBeNull()
    expect(parseStartMinute('9:99')).toBeNull()
  })
})

describe('minuteToTimeLabel', () => {
  it('round-trips with parseStartMinute', () => {
    expect(minuteToTimeLabel(1080)).toBe('18:00')
    expect(minuteToTimeLabel(570)).toBe('09:30')
  })
})

describe('resolveCatalogueHandle', () => {
  const subjects: CatalogueOption[] = [
    { handle: 'biology', label: 'Biology', aliases: ['bio'] },
    { handle: 'english_language', label: 'English Language' },
  ]
  it('matches by label, handle, and alias', () => {
    expect(resolveCatalogueHandle('Biology', subjects)).toMatchObject({ handle: 'biology', isNew: false })
    expect(resolveCatalogueHandle('bio', subjects)).toMatchObject({ handle: 'biology', isNew: false })
    expect(resolveCatalogueHandle('biology', subjects)).toMatchObject({ handle: 'biology', isNew: false })
  })
  it('synthesises a new handle for an unknown subject', () => {
    const r = resolveCatalogueHandle('Further Maths', subjects)
    expect(r).toEqual({ handle: 'further_maths', label: 'Further Maths', isNew: true })
  })
})

describe('buildTimetablePlan', () => {
  const subjects: CatalogueOption[] = [
    { handle: 'biology', label: 'Biology' },
    { handle: 'chemistry', label: 'Chemistry' },
  ]
  const levels: CatalogueOption[] = [
    { handle: 'gcse', label: 'GCSE' },
    { handle: 'a_level', label: 'A-Level' },
  ]

  it('builds classes, holidays and the cohort, flagging new subjects', () => {
    const ai: TimetableImportAiShape = {
      cohort: { name: '2026/2027', startsOn: '2026-09-01', endsOn: '2027-07-31' },
      holidays: [{ name: 'Christmas', startsOn: '2026-12-21', endsOn: '2027-01-02' }],
      classes: [
        {
          subject: 'Biology',
          level: 'A-Level',
          day: 'Saturday',
          startTime: '18:00',
          weeks: [
            { weekNumber: 1, topic: 'Cells' },
            { weekNumber: 2, topic: 'Transport' },
          ],
        },
        {
          subject: 'Physics',
          level: 'GCSE',
          day: 'Tuesday',
          startTime: '5pm',
          weeks: [],
        },
      ],
    }
    const plan = buildTimetablePlan(ai, { subjects, levels })
    expect(plan.cohort).toEqual({ name: '2026/2027', startsOn: '2026-09-01', endsOn: '2027-07-31' })
    expect(plan.holidays).toHaveLength(1)
    expect(plan.classes).toHaveLength(2)

    const bio = plan.classes[0]!
    expect(bio).toMatchObject({
      subjectHandle: 'biology',
      subjectIsNew: false,
      levelHandle: 'a_level',
      dayOfWeek: 5,
      startMinute: 1080,
      timeLabel: '18:00',
    })
    expect(bio.weeks).toHaveLength(2)

    const phys = plan.classes[1]!
    expect(phys).toMatchObject({ subjectHandle: 'physics', subjectIsNew: true, startMinute: 1020 })
  })

  it('drops classes with an unreadable day or time, with a warning', () => {
    const ai: TimetableImportAiShape = {
      cohort: { name: 'Year' },
      classes: [
        { subject: 'Biology', level: 'GCSE', day: 'someday', startTime: '18:00' },
        { subject: 'Chemistry', level: 'GCSE', day: 'Monday', startTime: 'noon' },
      ],
    }
    const plan = buildTimetablePlan(ai, { subjects, levels })
    expect(plan.classes).toHaveLength(0)
    expect(plan.warnings.length).toBe(2)
  })

  it('collapses duplicate subject+level pairs', () => {
    const ai: TimetableImportAiShape = {
      cohort: { name: 'Year' },
      classes: [
        { subject: 'Biology', level: 'GCSE', day: 'Monday', startTime: '18:00' },
        { subject: 'biology', level: 'gcse', day: 'Tuesday', startTime: '19:00' },
      ],
    }
    const plan = buildTimetablePlan(ai, { subjects, levels })
    expect(plan.classes).toHaveLength(1)
    expect(plan.warnings.some((w) => /duplicate/i.test(w))).toBe(true)
  })

  it('ignores invalid holiday dates', () => {
    const ai: TimetableImportAiShape = {
      cohort: { name: 'Year' },
      holidays: [
        { name: 'Bad range', startsOn: '2027-01-10', endsOn: '2027-01-01' },
        { name: 'No date', startsOn: 'soon', endsOn: 'later' },
      ],
      classes: [],
    }
    const plan = buildTimetablePlan(ai, { subjects, levels })
    expect(plan.holidays).toHaveLength(0)
    expect(plan.warnings.length).toBe(2)
  })
})
