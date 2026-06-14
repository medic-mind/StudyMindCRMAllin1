// Weekly reminder dispatcher. On each configured send day (default Mon + Tue),
// from the configured local hour, every active enrolment of every active class
// gets an email carrying that week's Zoom link and the class's PDF schedule
// (the uploaded syllabus PDF if there is one, else a generated schedule). Sent
// through the connected Google mailbox (sendSystemEmail → info@studymind.co.uk
// by default). Idempotent per (enrolment, week, send-day), so re-runs and
// overlapping days never double-send. Only `active` enrolments are emailed, so
// expired/cancelled subscriptions stop receiving links automatically.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import {
  DEFAULT_EMAIL_BODY_TEMPLATE,
  DEFAULT_EMAIL_SUBJECT_TEMPLATE,
  formatSessionDate,
  formatSessionTime,
  renderWebinarEmail,
  reminderDayNow,
  sessionForLocalWeek,
  sessionStartInstant,
  WEEKDAY_LABEL,
} from '@studymind/core/webinar'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'

import {
  buildClassSchedulePdf,
  loadClassSchedule,
  type ClassWithSchedule,
} from './schedule-helpers'

export interface DispatchResult {
  classesChecked: number
  remindersDue: number
  sent: number
  skipped: number
  failed: number
  errors: string[]
}

/**
 * Send all reminder emails due at `now`. The template, send schedule and
 * from-name come from each class's COHORT (CLAUDE.md §47); the sending mailbox
 * is the one global setting. Pass `now` so the cron and tests are deterministic.
 */
export async function dispatchDueWebinarEmails(
  db: PrismaClient,
  now: Date,
  requestId: string,
): Promise<DispatchResult> {
  const result: DispatchResult = {
    classesChecked: 0,
    remindersDue: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }
  const globalSettings = await db.webinarSettings.findUnique({
    where: { id: 'webinar' },
    select: { senderMailboxUserId: true },
  })
  const senderMailboxUserId = globalSettings?.senderMailboxUserId ?? null

  const classes = await db.webinarClass.findMany({
    where: { active: true, deletedAt: null, cohort: { status: 'active' } },
    select: {
      id: true,
      dayOfWeek: true,
      sendDaysOfWeek: true,
      sendHourLocal: true,
      timezone: true,
      emailSubjectTemplate: true,
      emailBodyTemplate: true,
      emailBodyHtml: true,
      cohort: {
        select: {
          name: true,
          emailSubjectTemplate: true,
          emailBodyTemplate: true,
          emailBodyHtml: true,
          fromName: true,
          sendDaysOfWeek: true,
          sendHourLocal: true,
        },
      },
    },
  })

  for (const cls of classes) {
    result.classesChecked += 1

    // Reminder schedule comes from the cohort (class still overrides if set).
    const sendDays = cls.cohort.sendDaysOfWeek ?? cls.sendDaysOfWeek
    const sendHour = cls.cohort.sendHourLocal ?? cls.sendHourLocal
    const reminderDay = reminderDayNow(now, cls.timezone, sendDays, sendHour)
    if (reminderDay === null) continue

    const schedule = await loadClassSchedule(db, cls.id)
    if (!schedule) continue

    // The session in THIS local week (the one the reminder is for). None during
    // a holiday week or out of term.
    const session = sessionForLocalWeek(schedule.sessions, now, schedule.timezone)
    if (!session) continue
    result.remindersDue += 1

    const startsAt = sessionStartInstant(session, schedule.startMinute, schedule.timezone)
    const dateLabel = formatSessionDate(startsAt, schedule.timezone)
    const timeLabel = formatSessionTime(startsAt, schedule.timezone)
    const topic = schedule.topics.get(session.weekNumber) ?? 'This week’s topic'

    const pdf = await classAttachment(db, cls.id, schedule)
    // Template resolution: the group's OWN template wins, then the year's
    // shared default, then the built-in. So each group edits its own email.
    const subjectTemplate =
      cls.emailSubjectTemplate || cls.cohort.emailSubjectTemplate || DEFAULT_EMAIL_SUBJECT_TEMPLATE
    const bodyTemplate =
      cls.emailBodyTemplate || cls.cohort.emailBodyTemplate || DEFAULT_EMAIL_BODY_TEMPLATE
    const htmlTemplate = cls.emailBodyHtml || cls.cohort.emailBodyHtml || null
    const fromName = cls.cohort.fromName || 'The StudyMind team'

    const enrollments = await db.webinarEnrollment.findMany({
      where: { classId: cls.id, status: 'active', deletedAt: null },
      include: { contact: { select: { id: true, firstName: true, email: true } } },
    })

    for (const enr of enrollments) {
      // Respect a known expiry that falls before this session.
      if (enr.expiresAt && enr.expiresAt.getTime() < startsAt.getTime()) {
        result.skipped += 1
        continue
      }
      const email = enr.contact.email
      if (!email) {
        result.skipped += 1
        continue
      }
      // Idempotency: claim (enrolment, week, send-day) before sending.
      const claimed = await claimDispatch(db, {
        classId: cls.id,
        enrollmentId: enr.id,
        weekNumber: session.weekNumber,
        sendDayOfWeek: reminderDay,
        sessionAt: startsAt,
      })
      if (!claimed) {
        result.skipped += 1
        continue
      }

      const rendered = renderWebinarEmail(
        subjectTemplate,
        bodyTemplate,
        {
          studentName: enr.contact.firstName || 'there',
          className: `${schedule.subjectLabel} ${schedule.levelLabel}`,
          subject: schedule.subjectLabel,
          level: schedule.levelLabel,
          cohortName: cls.cohort.name,
          weekday: WEEKDAY_LABEL[cls.dayOfWeek] ?? '',
          dateLabel,
          timeLabel,
          zoomLink: schedule.zoomLink || '(link to be confirmed)',
          weekNumber: session.weekNumber,
          weekTopic: topic,
          fromName,
        },
        htmlTemplate,
      )

      try {
        const send = await sendSystemEmail({
          to: email,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          attachments: pdf
            ? [{ filename: pdf.filename, content: pdf.content, contentType: 'application/pdf' }]
            : undefined,
          fromAgentId: senderMailboxUserId ?? undefined,
          requestId,
        })
        await db.webinarEmailDispatch.update({
          where: { id: claimed },
          data: {
            status: send.status === 'sent' ? 'sent' : 'failed',
            gmailMessageId: send.id,
            error: send.status === 'sent' ? null : (send.detail ?? send.status),
            sentAt: send.status === 'sent' ? new Date() : null,
          },
        })
        if (send.status === 'sent') result.sent += 1
        else result.failed += 1
      } catch (err) {
        await db.webinarEmailDispatch.update({
          where: { id: claimed },
          data: { status: 'failed', error: err instanceof Error ? err.message : 'send failed' },
        })
        result.failed += 1
      }
    }
  }
  return result
}

/** The PDF attachment for a class: uploaded syllabus if present, else generated. */
async function classAttachment(
  db: PrismaClient,
  classId: string,
  schedule: ClassWithSchedule,
): Promise<{ filename: string; content: Buffer } | null> {
  const uploaded = await db.webinarClass.findUnique({
    where: { id: classId },
    select: { syllabusPdfData: true, syllabusPdfFileName: true },
  })
  if (uploaded?.syllabusPdfData) {
    return {
      filename: uploaded.syllabusPdfFileName || 'syllabus.pdf',
      content: Buffer.from(uploaded.syllabusPdfData),
    }
  }
  try {
    return { filename: 'class-schedule.pdf', content: buildClassSchedulePdf(schedule) }
  } catch {
    return null
  }
}

/**
 * Insert the dispatch row, returning its id when WE created it (so we own the
 * send) or null when it already existed. The unique
 * (enrollmentId, weekNumber, sendDayOfWeek) constraint makes this race-safe.
 */
async function claimDispatch(
  db: PrismaClient,
  input: {
    classId: string
    enrollmentId: string
    weekNumber: number
    sendDayOfWeek: number
    sessionAt: Date
  },
): Promise<string | null> {
  const id = createId()
  try {
    const row = await db.webinarEmailDispatch.create({
      data: {
        id,
        classId: input.classId,
        enrollmentId: input.enrollmentId,
        weekNumber: input.weekNumber,
        sendDayOfWeek: input.sendDayOfWeek,
        sessionAt: input.sessionAt,
        status: 'scheduled',
      },
      select: { id: true },
    })
    return row.id
  } catch {
    return null
  }
}
