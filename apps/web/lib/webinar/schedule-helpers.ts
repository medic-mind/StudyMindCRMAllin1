// DB-backed helpers that turn a stored WebinarClass into concrete sessions and
// a schedule PDF, reusing the pure logic in @studymind/core/webinar.

import type { PrismaClient } from '@prisma/client'

import {
  buildSchedulePdf,
  computeSessions,
  formatSessionDateShort,
  formatSessionTime,
  sessionStartInstant,
  subjectLabel as subjectLabelFallback,
  levelLabel as levelLabelFallback,
  type ScheduleRow,
  type WebinarSession,
} from '@studymind/core/webinar'

export interface ClassWithSchedule {
  id: string
  title: string
  subject: string
  level: string
  /** Display labels resolved from the operator catalogue (UCAT, GAMSAT, …). */
  subjectLabel: string
  levelLabel: string
  dayOfWeek: number
  startMinute: number
  timezone: string
  zoomLink: string | null
  cohortName: string
  sessions: WebinarSession[]
  /** weekNumber -> topic, from the generated syllabus. */
  topics: Map<number, string>
}

/**
 * Load a class with its cohort, holidays and syllabus, and compute the term's
 * sessions. Returns null when the class does not exist or is soft-deleted.
 */
export async function loadClassSchedule(
  db: PrismaClient,
  classId: string,
): Promise<ClassWithSchedule | null> {
  const cls = await db.webinarClass.findFirst({
    where: { id: classId, deletedAt: null },
    include: {
      cohort: { include: { holidays: true } },
      syllabusWeeks: { orderBy: { weekNumber: 'asc' } },
    },
  })
  if (!cls) return null

  const sessions = computeSessions(
    cls.cohort.startsOn,
    cls.cohort.endsOn,
    cls.dayOfWeek,
    cls.cohort.holidays.map((h) => ({ startsOn: h.startsOn, endsOn: h.endsOn })),
  )
  const topics = new Map<number, string>()
  for (const w of cls.syllabusWeeks) topics.set(w.weekNumber, w.topic)

  const [subjectOpt, levelOpt] = await Promise.all([
    db.webinarSubjectOption.findUnique({ where: { handle: cls.subject }, select: { label: true } }),
    db.webinarLevelOption.findUnique({ where: { handle: cls.level }, select: { label: true } }),
  ])

  return {
    id: cls.id,
    title: cls.title,
    subject: cls.subject,
    level: cls.level,
    subjectLabel: subjectOpt?.label ?? subjectLabelFallback(cls.subject),
    levelLabel: levelOpt?.label ?? levelLabelFallback(cls.level),
    dayOfWeek: cls.dayOfWeek,
    startMinute: cls.startMinute,
    timezone: cls.timezone,
    zoomLink: cls.zoomLink,
    cohortName: cls.cohort.name,
    sessions,
    topics,
  }
}

/** Build the schedule rows (week, date, topic) used for the PDF + UI preview. */
export function scheduleRows(schedule: ClassWithSchedule): ScheduleRow[] {
  return schedule.sessions.map((s) => ({
    weekNumber: s.weekNumber,
    dateLabel: formatSessionDateShort(
      sessionStartInstant(s, schedule.startMinute, schedule.timezone),
      schedule.timezone,
    ),
    topic: schedule.topics.get(s.weekNumber) ?? 'Topic to be confirmed',
  }))
}

/** Generate the term-schedule PDF for a class. */
export function buildClassSchedulePdf(schedule: ClassWithSchedule): Buffer {
  const firstSession = schedule.sessions[0]
  const timeLabel = firstSession
    ? formatSessionTime(
        sessionStartInstant(firstSession, schedule.startMinute, schedule.timezone),
        schedule.timezone,
      )
    : ''
  return buildSchedulePdf({
    className: `${schedule.subjectLabel} ${schedule.levelLabel} — ${schedule.title}`,
    timeLabel,
    zoomLink: schedule.zoomLink,
    cohortName: schedule.cohortName,
    rows: scheduleRows(schedule),
  })
}
