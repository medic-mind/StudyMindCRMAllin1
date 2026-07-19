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

const SUBJECT_LABEL: Record<string, string> = {
  biology: 'Biology',
  chemistry: 'Chemistry',
  physics: 'Physics',
  maths: 'Maths',
  english_language: 'English Language',
}

// The live 2026/2027 group schedule. weekday 0=Mon..6=Sun; minute is local.
// GCSE = Years 10-11, A-Level = Years 12-13.
const CLASSES: Array<{ subject: string; level: 'gcse' | 'a_level'; day: number; minute: number }> = [
  { subject: 'biology', level: 'gcse', day: 5, minute: 17 * 60 }, // Sat 17:00-18:00
  { subject: 'chemistry', level: 'gcse', day: 6, minute: 17 * 60 }, // Sun 17:00-18:00
  { subject: 'maths', level: 'gcse', day: 4, minute: 17 * 60 }, // Fri 17:00-18:00
  { subject: 'physics', level: 'gcse', day: 3, minute: 17 * 60 }, // Thu 17:00-18:00
  { subject: 'english_language', level: 'gcse', day: 2, minute: 17 * 60 }, // Wed 17:00-18:00
  { subject: 'biology', level: 'a_level', day: 5, minute: 18 * 60 }, // Sat 18:00-19:00
  { subject: 'chemistry', level: 'a_level', day: 6, minute: 18 * 60 }, // Sun 18:00-19:00
  { subject: 'maths', level: 'a_level', day: 4, minute: 18 * 60 }, // Fri 18:00-19:00
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

const SUBJECT_OPTIONS: Array<{ handle: string; label: string; aliases?: string[]; sortOrder: number }> = [
  { handle: 'biology', label: 'Biology', aliases: ['bio'], sortOrder: 10 },
  { handle: 'chemistry', label: 'Chemistry', aliases: ['chem'], sortOrder: 20 },
  { handle: 'physics', label: 'Physics', aliases: ['phys'], sortOrder: 30 },
  { handle: 'maths', label: 'Maths', aliases: ['math', 'mathematics'], sortOrder: 40 },
  { handle: 'english_language', label: 'English Language', aliases: ['english'], sortOrder: 50 },
]

// GCSE + A-Level ship live; UCAT + GAMSAT are seeded as ready-to-use examples
// of the extensible level/type catalogue (admins add more from the UI).
const LEVEL_OPTIONS: Array<{ handle: string; label: string; aliases?: string[]; sortOrder: number }> = [
  { handle: 'a_level', label: 'A-Level', aliases: ['a level', 'as', 'a2', 'ks5'], sortOrder: 10 },
  { handle: 'gcse', label: 'GCSE', aliases: ['ks4', 'igcse'], sortOrder: 20 },
  { handle: 'ucat', label: 'UCAT', aliases: ['ukcat'], sortOrder: 30 },
  { handle: 'gamsat', label: 'GAMSAT', sortOrder: 40 },
]

export async function seedWebinar(): Promise<{ cohortId: string; classes: number }> {
  for (const s of SUBJECT_OPTIONS) {
    await db.webinarSubjectOption.upsert({
      where: { handle: s.handle },
      create: { id: createId(), handle: s.handle, label: s.label, aliases: s.aliases ?? [], sortOrder: s.sortOrder },
      update: {},
    })
  }
  for (const l of LEVEL_OPTIONS) {
    await db.webinarLevelOption.upsert({
      where: { handle: l.handle },
      create: { id: createId(), handle: l.handle, label: l.label, aliases: l.aliases ?? [], sortOrder: l.sortOrder },
      update: {},
    })
  }

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
    const levelLabel = c.level === 'a_level' ? 'A-Level' : 'GCSE'
    const years = c.level === 'a_level' ? 'Y12-13' : 'Y10-11'
    const title = `${levelLabel} ${SUBJECT_LABEL[c.subject] ?? c.subject} (${years}) weekly class`
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
