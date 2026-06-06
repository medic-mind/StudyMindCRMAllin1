// Distribute class recordings (ADR 0035). After a session, fetch the class
// meeting's cloud recording from Zoom, email the share link to the active
// mailing list, and — only when the operator has opted in — move it to Zoom
// Trash (recoverable) once sent. Everything is OFF by default and fails closed
// when Zoom isn't configured. Idempotent per (class, occurrence).

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'
import { client as zoomClient } from '@studymind/integration-zoom'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'

export interface RecordingsResult {
  enabled: boolean
  classesChecked: number
  sent: number
  trashed: number
  skipped: number
  errors: string[]
}

export async function sendDueRecordings(
  db: PrismaClient,
  now: Date,
  requestId: string,
): Promise<RecordingsResult> {
  const result: RecordingsResult = {
    enabled: false,
    classesChecked: 0,
    sent: 0,
    trashed: 0,
    skipped: 0,
    errors: [],
  }
  if (!zoomClient.isConfigured()) return result

  const settings = await db.webinarSettings.findUnique({
    where: { id: 'webinar' },
    select: { zoomSendRecordings: true, zoomTrashAfterSend: true, fromName: true, senderMailboxUserId: true },
  })
  if (!settings?.zoomSendRecordings) return result
  result.enabled = true

  const classes = await db.webinarClass.findMany({
    where: {
      active: true,
      deletedAt: null,
      cohort: { status: 'active' },
      zoomMeetingId: { not: null },
    },
    select: { id: true, subject: true, level: true, zoomMeetingId: true },
  })

  for (const cls of classes) {
    result.classesChecked += 1
    if (!cls.zoomMeetingId) continue
    let recordings
    try {
      recordings = await zoomClient.getMeetingRecordings(cls.zoomMeetingId)
    } catch (err) {
      result.errors.push(`Class ${cls.id}: ${err instanceof Error ? err.message : 'recordings fetch failed'}`)
      continue
    }
    if (!recordings || recordings.recording_files.length === 0) {
      result.skipped += 1
      continue
    }

    const occurrenceUuid = recordings.uuid
    const shareUrl =
      recordings.share_url ??
      recordings.recording_files.find((f) => f.play_url)?.play_url ??
      recordings.recording_files[0]?.download_url ??
      null

    // Idempotency claim.
    const dispatchId = createId()
    try {
      await db.webinarRecordingDispatch.create({
        data: { id: dispatchId, classId: cls.id, occurrenceUuid, shareUrl, status: 'sent' },
      })
    } catch {
      result.skipped += 1
      continue
    }

    const enrollments = await db.webinarEnrollment.findMany({
      where: { classId: cls.id, status: 'active', deletedAt: null },
      include: { contact: { select: { firstName: true, email: true } } },
    })
    const [subjectOpt, levelOpt] = await Promise.all([
      db.webinarSubjectOption.findUnique({ where: { handle: cls.subject }, select: { label: true } }),
      db.webinarLevelOption.findUnique({ where: { handle: cls.level }, select: { label: true } }),
    ])
    const className = `${subjectOpt?.label ?? cls.subject} ${levelOpt?.label ?? cls.level}`
    const fromName = settings.fromName || 'The StudyMind team'

    let recipientCount = 0
    for (const enr of enrollments) {
      const email = enr.contact.email
      if (!email || !shareUrl) {
        continue
      }
      const send = await sendSystemEmail({
        to: email,
        subject: `${className} — class recording`,
        text: [
          `Hi ${enr.contact.firstName || 'there'},`,
          '',
          `Here is the recording of this week's ${className} class:`,
          '',
          `  ${shareUrl}`,
          '',
          'See you next week,',
          fromName,
        ].join('\n'),
        fromAgentId: settings.senderMailboxUserId ?? undefined,
        requestId,
      })
      if (send.status === 'sent') recipientCount += 1
    }

    await db.webinarRecordingDispatch.update({
      where: { id: dispatchId },
      data: { recipientCount, sentAt: new Date() },
    })
    await writeAuditLogEntry(db, {
      actorId: null,
      action: 'webinar.recording_sent',
      target: { type: 'WebinarClass', id: cls.id },
      after: { occurrenceUuid, recipientCount },
      requestId,
    })
    result.sent += 1

    // Opt-in clean-up: move the recording to Zoom Trash (recoverable) only after
    // a successful send, and only if at least one recipient got it.
    if (settings.zoomTrashAfterSend && recipientCount > 0) {
      try {
        await zoomClient.trashMeetingRecordings(cls.zoomMeetingId, { permanent: false })
        await db.webinarRecordingDispatch.update({
          where: { id: dispatchId },
          data: { status: 'trashed', trashedAt: new Date() },
        })
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'webinar.recording_trashed',
          target: { type: 'WebinarClass', id: cls.id },
          after: { occurrenceUuid },
          requestId,
        })
        result.trashed += 1
      } catch (err) {
        result.errors.push(`Class ${cls.id}: trash failed — ${err instanceof Error ? err.message : 'error'}`)
      }
    }
  }

  return result
}
