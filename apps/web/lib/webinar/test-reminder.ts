// Send a real "what students get" reminder (rendered email + the branded
// schedule PDF) to one address — the inbox preview behind the group page's
// "Send test to me". Mirrors the dispatcher's template resolution (the group's
// own template wins) so the preview is faithful.

import type { PrismaClient } from '@prisma/client'

import {
  DEFAULT_EMAIL_BODY_TEMPLATE,
  DEFAULT_EMAIL_SUBJECT_TEMPLATE,
  formatSessionDateShort,
  formatSessionTime,
  renderWebinarEmail,
  sessionForLocalWeek,
  sessionStartInstant,
  WEEKDAY_LABEL,
} from '@studymind/core/webinar'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'

import { buildClassSchedulePdf, loadClassSchedule } from './schedule-helpers'

export interface TestReminderResult {
  status: 'sent' | 'skipped' | 'error'
  detail?: string
}

export async function sendTestReminderForClass(
  db: PrismaClient,
  classId: string,
  toEmail: string,
  requestId: string,
): Promise<TestReminderResult> {
  const schedule = await loadClassSchedule(db, classId)
  if (!schedule) return { status: 'error', detail: 'Group not found' }

  const cls = await db.webinarClass.findUnique({
    where: { id: classId },
    select: {
      emailSubjectTemplate: true,
      emailBodyTemplate: true,
      emailBodyHtml: true,
      cohort: {
        select: {
          emailSubjectTemplate: true,
          emailBodyTemplate: true,
          emailBodyHtml: true,
          fromName: true,
        },
      },
    },
  })
  if (!cls) return { status: 'error', detail: 'Group not found' }

  // Group's own template wins, then the year's shared default, then built-in.
  const subjectTemplate =
    cls.emailSubjectTemplate || cls.cohort.emailSubjectTemplate || DEFAULT_EMAIL_SUBJECT_TEMPLATE
  const bodyTemplate =
    cls.emailBodyTemplate || cls.cohort.emailBodyTemplate || DEFAULT_EMAIL_BODY_TEMPLATE
  const htmlTemplate = cls.emailBodyHtml || cls.cohort.emailBodyHtml || null

  // Use this week's session if there is one, else the first of term, for sample
  // values that look real.
  const session =
    sessionForLocalWeek(schedule.sessions, new Date(), schedule.timezone) ?? schedule.sessions[0]
  const startsAt = session
    ? sessionStartInstant(session, schedule.startMinute, schedule.timezone)
    : new Date()

  const rendered = renderWebinarEmail(
    subjectTemplate,
    bodyTemplate,
    {
      studentName: 'there (test send)',
      className: `${schedule.subjectLabel} ${schedule.levelLabel}`,
      subject: schedule.subjectLabel,
      level: schedule.levelLabel,
      cohortName: schedule.cohortName,
      weekday: WEEKDAY_LABEL[schedule.dayOfWeek] ?? '',
      dateLabel: formatSessionDateShort(startsAt, schedule.timezone),
      timeLabel: formatSessionTime(startsAt, schedule.timezone),
      zoomLink: schedule.zoomLink || '(set the Zoom link)',
      weekNumber: session?.weekNumber ?? 1,
      weekTopic: session
        ? (schedule.topics.get(session.weekNumber) ?? 'This week’s topic')
        : 'This week’s topic',
      fromName: cls.cohort.fromName || 'The StudyMind team',
    },
    htmlTemplate,
  )

  const pdf = buildClassSchedulePdf(schedule)
  const res = await sendSystemEmail({
    to: toEmail,
    subject: `[Test] ${rendered.subject}`,
    text: rendered.text,
    html: rendered.html,
    attachments: [{ filename: 'class-schedule.pdf', content: pdf, contentType: 'application/pdf' }],
    requestId,
  })
  return { status: res.status === 'sent' ? 'sent' : 'error', detail: res.detail ?? undefined }
}
