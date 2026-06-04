// Idempotent seed for the weekly-webinar system: two cohorts (2026/2027 active,
// 2027/2028 planning), the usual UK term breaks, the eight subject×level classes
// for the active year, and the default email settings. Safe to re-run.

import { createId } from '@paralleldrive/cuid2'

import { db } from '../src/index'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)

interface HolidaySpec {
  name: string
  startsOn: string
  endsOn: string
}

// Approximate England term breaks for 2026/2027.
const HOLIDAYS_2026: HolidaySpec[] = [
  { name: 'October half term', startsOn: '2026-10-26', endsOn: '2026-10-30' },
  { name: 'Christmas break', startsOn: '2026-12-21', endsOn: '2027-01-01' },
  { name: 'February half term', startsOn: '2027-02-15', endsOn: '2027-02-19' },
  { name: 'Easter break', startsOn: '2027-03-29', endsOn: '2027-04-09' },
  { name: 'May half term', startsOn: '2027-05-31', endsOn: '2027-06-04' },
]

// subject, level, weekday (0=Mon), start minute (local).
const CLASSES: Array<{ subject: string; level: 'gcse' | 'a_level'; day: number; minute: number }> = [
  { subject: 'biology', level: 'gcse', day: 0, minute: 17 * 60 }, // Mon 17:00
  { subject: 'biology', level: 'a_level', day: 0, minute: 18 * 60 }, // Mon 18:00
  { subject: 'chemistry', level: 'gcse', day: 1, minute: 17 * 60 }, // Tue 17:00
  { subject: 'chemistry', level: 'a_level', day: 1, minute: 18 * 60 },
  { subject: 'physics', level: 'gcse', day: 2, minute: 17 * 60 }, // Wed 17:00
  { subject: 'physics', level: 'a_level', day: 2, minute: 18 * 60 },
  { subject: 'maths', level: 'gcse', day: 3, minute: 17 * 60 }, // Thu 17:00
  { subject: 'maths', level: 'a_level', day: 3, minute: 18 * 60 },
]

const DEFAULT_SUBJECT_TEMPLATE = "{{className}} — this week's class ({{dateLabel}})"
const DEFAULT_BODY_TEMPLATE = `Hi {{studentName}},

Here are the details for this week's {{className}} session:

  • When: {{dateLabel}} at {{timeLabel}}
  • Week {{weekNumber}}: {{weekTopic}}
  • Join here: {{zoomLink}}

The full term schedule is attached as a PDF. Save the join link — it is the
same each week unless we tell you otherwise.

See you there,
{{fromName}}`

export async function seedWebinar(): Promise<{ cohortId: string; classes: number }> {
  const cohort2026 = await db.webinarCohort.upsert({
    where: { name: '2026/2027' },
    create: {
      id: createId(),
      name: '2026/2027',
      startsOn: d('2026-09-01'),
      endsOn: d('2027-07-17'),
      status: 'active',
      timezone: 'Europe/London',
    },
    update: {},
  })

  await db.webinarCohort.upsert({
    where: { name: '2027/2028' },
    create: {
      id: createId(),
      name: '2027/2028',
      startsOn: d('2027-09-01'),
      endsOn: d('2028-07-15'),
      status: 'planning',
      timezone: 'Europe/London',
    },
    update: {},
  })

  for (const h of HOLIDAYS_2026) {
    const exists = await db.webinarHoliday.findFirst({
      where: { cohortId: cohort2026.id, name: h.name },
      select: { id: true },
    })
    if (!exists) {
      await db.webinarHoliday.create({
        data: {
          id: createId(),
          cohortId: cohort2026.id,
          name: h.name,
          startsOn: d(h.startsOn),
          endsOn: d(h.endsOn),
        },
      })
    }
  }

  for (const c of CLASSES) {
    const title = `${c.subject[0]!.toUpperCase()}${c.subject.slice(1)} ${
      c.level === 'a_level' ? 'A-Level' : 'GCSE'
    } weekly class`
    await db.webinarClass.upsert({
      where: {
        cohortId_subject_level: { cohortId: cohort2026.id, subject: c.subject, level: c.level },
      },
      create: {
        id: createId(),
        cohortId: cohort2026.id,
        subject: c.subject,
        level: c.level,
        title,
        dayOfWeek: c.day,
        startMinute: c.minute,
        durationMins: 60,
        timezone: 'Europe/London',
        sendOffsetHours: 24,
        zoomRotateEveryWeeks: 4,
      },
      update: {},
    })
  }

  await db.webinarSettings.upsert({
    where: { id: 'webinar' },
    create: {
      id: 'webinar',
      defaultSendOffsetHours: 24,
      defaultZoomRotateEveryWeeks: 4,
      emailSubjectTemplate: DEFAULT_SUBJECT_TEMPLATE,
      emailBodyTemplate: DEFAULT_BODY_TEMPLATE,
      fromName: 'The StudyMind team',
    },
    update: {},
  })

  return { cohortId: cohort2026.id, classes: CLASSES.length }
}
