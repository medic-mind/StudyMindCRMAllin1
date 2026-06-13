import { describe, expect, it } from 'vitest'

import {
  buildTimetablePlan,
  minuteToTimeLabel,
  parseDelimitedRows,
  parseStartMinute,
  parseTabularTimetable,
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
  it('tolerates plurals and embedded weekday names', () => {
    expect(weekdayToIndex('Saturdays')).toBe(5)
    expect(weekdayToIndex('every saturday')).toBe(5)
    expect(weekdayToIndex('Thursday evenings')).toBe(3)
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
  it('tolerates dots, spaces, ranges, noon/midnight', () => {
    expect(parseStartMinute('18.00')).toBe(1080)
    expect(parseStartMinute('6.30 pm')).toBe(1110)
    expect(parseStartMinute('9 am')).toBe(540)
    expect(parseStartMinute('6-8pm')).toBe(1080) // trailing pm applies to start
    expect(parseStartMinute('9am-1pm')).toBe(540)
    expect(parseStartMinute('noon')).toBe(720)
    expect(parseStartMinute('midnight')).toBe(0)
  })
  it('rejects bad input', () => {
    expect(parseStartMinute('half six')).toBeNull()
    expect(parseStartMinute('')).toBeNull()
  })
})

describe('parseDelimitedRows', () => {
  it('handles quoted fields with embedded commas', () => {
    const rows = parseDelimitedRows('a,b,c\n1,"two, 2",3')
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, 2', '3'],
    ])
  })
})

describe('parseTabularTimetable', () => {
  const csv = [
    'Subject,Level,Week,Date,Day,Start,End,Year,Type,Title,Detail,Notes,Runs',
    'A-level Biology,A-level,1,2026-09-12,Saturday,18:00,19:00,Year 12,Class,Biological molecules,"Monomers, polymers.",,Yes',
    'A-level Biology,A-level,2,2026-09-19,Saturday,18:00,19:00,Year 13,Class,Energy transfers,"The Calvin cycle.",,Yes',
    'A-level Biology,A-level,3,2026-12-26,Saturday,18:00,19:00,,No class,No class,,Boxing Day (public holiday),No',
    'A-level Biology,A-level,4,2027-01-09,Saturday,18:00,19:00,Year 12,Class,Exchange,"SA to volume ratio.",,Yes',
  ].join('\n')

  const subjects: CatalogueOption[] = [{ handle: 'biology', label: 'Biology', aliases: ['bio'] }]
  const levels: CatalogueOption[] = [{ handle: 'a_level', label: 'A-Level', aliases: ['a-level'] }]

  it('parses the columnar schedule into one class + holiday, renumbering teaching weeks', () => {
    const shape = parseTabularTimetable(csv)
    expect(shape).not.toBeNull()
    expect(shape!.classes).toHaveLength(1)
    const c = shape!.classes![0]!
    expect(c.subject).toBe('Biology') // level token stripped from "A-level Biology"
    expect(c.level).toBe('A-level')
    expect(c.day).toBe('Saturday')
    expect(c.startTime).toBe('18:00')
    // 3 teaching rows (the No-class row is excluded), renumbered 1..3 by date.
    expect(c.weeks).toEqual([
      { weekNumber: 1, topic: 'Biological molecules' },
      { weekNumber: 2, topic: 'Energy transfers' },
      { weekNumber: 3, topic: 'Exchange' },
    ])
    expect(shape!.holidays).toEqual([
      { name: 'Boxing Day (public holiday)', startsOn: '2026-12-26', endsOn: '2026-12-26' },
    ])
    expect(shape!.cohort!.name).toBe('2026/2027')
    expect(shape!.cohort!.startsOn).toBe('2026-09-12')
  })

  it('flows through buildTimetablePlan into a clean, catalogue-resolved plan', () => {
    const shape = parseTabularTimetable(csv)!
    const plan = buildTimetablePlan(shape, { subjects, levels })
    expect(plan.classes).toHaveLength(1)
    expect(plan.classes[0]).toMatchObject({
      subjectHandle: 'biology',
      subjectIsNew: false,
      levelHandle: 'a_level',
      levelIsNew: false,
      dayOfWeek: 5,
      startMinute: 1080,
    })
    expect(plan.classes[0]!.weeks).toHaveLength(3)
    expect(plan.holidays).toHaveLength(1)
  })

  it('returns null for non-tabular prose', () => {
    expect(parseTabularTimetable('Our Biology class runs on Saturdays at 6pm.')).toBeNull()
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
        { subject: 'Chemistry', level: 'GCSE', day: 'Monday', startTime: 'lunchtime' },
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
