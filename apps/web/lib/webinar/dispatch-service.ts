// Weekly email dispatcher. For every active class with a session whose send
// window has opened, email each active enrolment the Zoom link + a PDF schedule
// via the connected Google mailbox (sendSystemEmail). Idempotent: a unique
// (enrollmentId, weekNumber) dispatch row guards against double-sends across
// retries. Only `active` enrolments are emailed, so expired subscriptions stop
// receiving links automatically (CLAUDE.md §3, §17.2).

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import {
  DEFAULT_EMAIL_BODY_TEMPLATE,
  DEFAULT_EMAIL_SUBJECT_TEMPLATE,
  dueSessions,
  formatSessionDate,
  formatSessionTime,
  levelLabel,
  renderWebinarEmail,
  subjectLabel,
} from '@studymind/core/webinar'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'

import {
  buildClassSchedulePdf,
  loadClassSchedule,
  type ClassWithSchedule,
} from './schedule-helpers'

export interface DispatchResult {
  classesChecked: number
  sessionsDue: number
  sent: number
  skipped: number
  failed: number
  errors: string[]
}

interface ResolvedSettings {
  subjectTemplate: string
  bodyTemplate: string
  fromName: string
  senderMailboxUserId: string | null
}

async function resolveSettings(db: PrismaClient): Promise<ResolvedSettings> {
  const row = await db.webinarSettings.findUnique({ where: { id: 'webinar' } })
  return {
    subjectTemplate: row?.emailSubjectTemplate || DEFAULT_EMAIL_SUBJECT_TEMPLATE,
    bodyTemplate: row?.emailBodyTemplate || DEFAULT_EMAIL_BODY_TEMPLATE,
    fromName: row?.fromName || 'The StudyMind team',
    senderMailboxUserId: row?.senderMailboxUserId ?? null,
  }
}

/**
 * Send all webinar emails whose send time has arrived. Pass `now` so the cron
 * and tests are deterministic.
 */
export async function dispatchDueWebinarEmails(
  db: PrismaClient,
  now: Date,
  requestId: string,
): Promise<DispatchResult> {
  const result: DispatchResult = {
    classesChecked: 0,
    sessionsDue: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }
  const settings = await resolveSettings(db)

  const classes = await db.webinarClass.findMany({
    where: { active: true, deletedAt: null, cohort: { status: 'active' } },
    select: { id: true, sendOffsetHours: true, emailSubjectTemplate: true, emailBodyTemplate: true },
  })

  for (const cls of classes) {
    result.classesChecked += 1
    const schedule = await loadClassSchedule(db, cls.id)
    if (!schedule) continue

    const due = dueSessions(
      schedule.sessions,
      schedule.startMinute,
      schedule.timezone,
      cls.sendOffsetHours,
      now,
    )
    if (due.length === 0) continue
    result.sessionsDue += due.length

    // Build the schedule PDF once per class (same attachment for everyone).
    const pdf = await classAttachment(db, cls.id, schedule)
    const subjectTemplate = cls.emailSubjectTemplate || settings.subjectTemplate
    const bodyTemplate = cls.emailBodyTemplate || settings.bodyTemplate

    const enrollments = await db.webinarEnrollment.findMany({
      where: { classId: cls.id, status: 'active', deletedAt: null },
      include: { contact: { select: { id: true, firstName: true, email: true } } },
    })

    for (const d of due) {
      const startsAt = d.startsAt
      const dateLabel = formatSessionDate(startsAt, schedule.timezone)
      const timeLabel = formatSessionTime(startsAt, schedule.timezone)
      const topic = schedule.topics.get(d.session.weekNumber) ?? 'This week’s topic'

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
        // Idempotency: claim (enrollmentId, weekNumber) before sending.
        const claimed = await claimDispatch(db, {
          classId: cls.id,
          enrollmentId: enr.id,
          weekNumber: d.session.weekNumber,
          sessionAt: startsAt,
        })
        if (!claimed) {
          result.skipped += 1
          continue
        }

        const rendered = renderWebinarEmail(subjectTemplate, bodyTemplate, {
          studentName: enr.contact.firstName || 'there',
          className: `${subjectLabel(schedule.subject)} ${levelLabel(schedule.level)}`,
          subject: subjectLabel(schedule.subject),
          level: levelLabel(schedule.level),
          dateLabel,
          timeLabel,
          zoomLink: schedule.zoomLink || '(link to be confirmed)',
          weekNumber: d.session.weekNumber,
          weekTopic: topic,
          fromName: settings.fromName,
        })

        try {
          const send = await sendSystemEmail({
            to: email,
            subject: rendered.subject,
            text: rendered.text,
            attachments: pdf
              ? [{ filename: pdf.filename, content: pdf.content, contentType: 'application/pdf' }]
              : undefined,
            fromAgentId: settings.senderMailboxUserId ?? undefined,
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
 * send) or null when it already existed (another run claimed it). The unique
 * (enrollmentId, weekNumber) constraint makes this race-safe.
 */
async function claimDispatch(
  db: PrismaClient,
  input: { classId: string; enrollmentId: string; weekNumber: number; sessionAt: Date },
): Promise<string | null> {
  const id = createId()
  try {
    const row = await db.webinarEmailDispatch.create({
      data: {
        id,
        classId: input.classId,
        enrollmentId: input.enrollmentId,
        weekNumber: input.weekNumber,
        sessionAt: input.sessionAt,
        status: 'scheduled',
      },
      select: { id: true },
    })
    return row.id
  } catch {
    // Unique violation — already claimed/sent. Skip.
    return null
  }
}
