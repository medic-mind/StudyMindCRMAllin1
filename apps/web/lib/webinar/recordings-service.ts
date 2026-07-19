// Distribute class recordings (ADR 0035). After a session, fetch the class
// meeting's cloud recording from Zoom, email the share link to the active
// mailing list, and — only when the operator has opted in — move it to Zoom
// Trash (recoverable) once sent. Everything is OFF by default and fails closed
// when Zoom isn't configured. Idempotent per (class, occurrence).
//
// Exposes three entry points: the hourly sweep (`sendDueRecordings`), a single
// class (`sendRecordingsForClassId`, used by the "send now" button), and by Zoom
// meeting id (`sendRecordingsForMeetingId`, used by the recording.completed
// webhook).

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

interface ClassRow {
  id: string
  subject: string
  level: string
  zoomMeetingId: string | null
}

interface SettingsRow {
  zoomSendRecordings: boolean
  zoomTrashAfterSend: boolean
  fromName: string | null
  senderMailboxUserId: string | null
  senderAddress: string | null
}

const EMPTY: Omit<RecordingsResult, 'enabled'> = {
  classesChecked: 0,
  sent: 0,
  trashed: 0,
  skipped: 0,
  errors: [],
}

async function loadSettings(db: PrismaClient): Promise<SettingsRow | null> {
  return db.webinarSettings.findUnique({
    where: { id: 'webinar' },
    select: {
      zoomSendRecordings: true,
      zoomTrashAfterSend: true,
      fromName: true,
      senderMailboxUserId: true,
      senderAddress: true,
    },
  })
}

/** Send recordings for ONE class. `force` bypasses the auto-send flag (manual). */
async function sendForClass(
  db: PrismaClient,
  cls: ClassRow,
  settings: SettingsRow,
  requestId: string,
  result: RecordingsResult,
): Promise<void> {
  result.classesChecked += 1
  if (!cls.zoomMeetingId) {
    result.skipped += 1
    return
  }
  let recordings
  try {
    recordings = await zoomClient.getMeetingRecordings(cls.zoomMeetingId)
  } catch (err) {
    result.errors.push(`Class ${cls.id}: ${err instanceof Error ? err.message : 'recordings fetch failed'}`)
    return
  }
  if (!recordings || recordings.recording_files.length === 0) {
    result.skipped += 1
    return
  }

  const occurrenceUuid = recordings.uuid
  const shareUrl =
    recordings.share_url ??
    recordings.recording_files.find((f) => f.play_url)?.play_url ??
    recordings.recording_files[0]?.download_url ??
    null

  const dispatchId = createId()
  try {
    await db.webinarRecordingDispatch.create({
      data: { id: dispatchId, classId: cls.id, occurrenceUuid, shareUrl, status: 'sent' },
    })
  } catch {
    result.skipped += 1
    return
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
    if (!email || !shareUrl) continue
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
      fromAddress: settings.senderAddress ?? undefined,
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

/** Hourly sweep: every active class with a Zoom meeting, if auto-send is on. */
export async function sendDueRecordings(
  db: PrismaClient,
  now: Date,
  requestId: string,
): Promise<RecordingsResult> {
  const result: RecordingsResult = { enabled: false, ...EMPTY, errors: [] }
  if (!zoomClient.isConfigured()) return result
  const settings = await loadSettings(db)
  if (!settings?.zoomSendRecordings) return result
  result.enabled = true

  const classes = await db.webinarClass.findMany({
    where: { active: true, deletedAt: null, cohort: { status: 'active' }, zoomMeetingId: { not: null } },
    select: { id: true, subject: true, level: true, zoomMeetingId: true },
  })
  for (const cls of classes) await sendForClass(db, cls, settings, requestId, result)
  return result
}

/** Send recordings for one class id. `force` bypasses the auto-send flag. */
export async function sendRecordingsForClassId(
  db: PrismaClient,
  classId: string,
  requestId: string,
  opts: { force?: boolean } = {},
): Promise<RecordingsResult> {
  const result: RecordingsResult = { enabled: false, ...EMPTY, errors: [] }
  if (!zoomClient.isConfigured()) {
    result.errors.push('Zoom is not configured.')
    return result
  }
  const settings = await loadSettings(db)
  if (!settings) {
    result.errors.push('Webinar settings not initialised.')
    return result
  }
  if (!opts.force && !settings.zoomSendRecordings) return result
  result.enabled = true
  const cls = await db.webinarClass.findFirst({
    where: { id: classId, deletedAt: null },
    select: { id: true, subject: true, level: true, zoomMeetingId: true },
  })
  if (!cls) {
    result.errors.push('Class not found.')
    return result
  }
  await sendForClass(db, cls, settings, requestId, result)
  return result
}

/** Send recordings for the class backing a Zoom meeting id (webhook path). */
export async function sendRecordingsForMeetingId(
  db: PrismaClient,
  meetingId: string,
  requestId: string,
): Promise<RecordingsResult> {
  const result: RecordingsResult = { enabled: false, ...EMPTY, errors: [] }
  if (!zoomClient.isConfigured()) return result
  const settings = await loadSettings(db)
  if (!settings?.zoomSendRecordings) return result
  result.enabled = true
  const cls = await db.webinarClass.findFirst({
    where: { zoomMeetingId: meetingId, deletedAt: null },
    select: { id: true, subject: true, level: true, zoomMeetingId: true },
  })
  if (!cls) {
    result.skipped += 1
    return result
  }
  await sendForClass(db, cls, settings, requestId, result)
  return result
}
