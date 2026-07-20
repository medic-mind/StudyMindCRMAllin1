// Zoom meeting lifecycle for a class (ADR 0035 amendment). ONE implementation
// of "generate/rotate this class's meeting" shared by the manual button
// (webinar.class.generateZoomLink) and the weekly auto-rotation job: create the
// new open-to-all recurring meeting, delete the old one so its link dies (the
// point of rotation — a lapsed member can't reuse it), stamp the class row, and
// audit. Credentials resolve via loadZoomConfig (Settings row, else env).

import type { PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'
import { subjectLabel, levelLabel } from '@studymind/core/webinar'
import { client as zoomClient } from '@studymind/integration-zoom'

import { loadZoomConfig } from './zoom-config'

export class ZoomNotConfiguredError extends Error {
  override readonly name = 'ZoomNotConfiguredError'
  constructor() {
    super('Zoom is not connected. Connect it in Webinars → Settings first.')
  }
}

export interface RotateResult {
  id: string
  joinUrl: string
  meetingId: string
}

/**
 * Create (or rotate) the class's Zoom meeting. Throws ZoomNotConfiguredError
 * when no credentials resolve; propagates Zoom API errors (callers decide how
 * loud to be — the tRPC mutation surfaces them, the cron records + tasks them).
 */
export async function rotateClassZoomLink(
  db: PrismaClient,
  classId: string,
  ctx: { actorId: string | null; requestId: string },
): Promise<RotateResult> {
  const config = await loadZoomConfig(db)
  if (!config) throw new ZoomNotConfiguredError()

  const cls = await db.webinarClass.findFirst({
    where: { id: classId, deletedAt: null },
    include: { cohort: { select: { name: true } } },
  })
  if (!cls) throw new Error('Class not found')
  const settings = await db.webinarSettings.findUnique({
    where: { id: 'webinar' },
    select: { zoomHostEmail: true },
  })
  const host = cls.zoomHostEmail || settings?.zoomHostEmail || undefined
  const topic = `${subjectLabel(cls.subject)} ${levelLabel(cls.level)} — ${cls.cohort.name}`

  const meeting = await zoomClient.createRecurringMeeting(
    { hostEmail: host, topic, timezone: cls.timezone },
    config,
  )

  // Delete the OLD meeting so its join link stops working.
  if (cls.zoomMeetingId && cls.zoomMeetingId !== String(meeting.id)) {
    try {
      await zoomClient.deleteMeeting(cls.zoomMeetingId, config)
      await writeAuditLogEntry(db, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        action: 'webinar.zoom_meeting_deleted',
        target: { type: 'WebinarClass', id: classId },
        before: { zoomMeetingId: cls.zoomMeetingId },
      })
    } catch {
      // Best effort — the new link is already live.
    }
  }

  await db.webinarClass.update({
    where: { id: classId },
    data: {
      zoomLink: meeting.join_url,
      zoomMeetingId: String(meeting.id),
      zoomHostEmail: host ?? null,
      zoomLinkUpdatedAt: new Date(),
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'webinar.zoom_meeting_created',
    target: { type: 'WebinarClass', id: classId },
    after: { zoomMeetingId: String(meeting.id), auto: ctx.actorId === null },
  })

  return { id: classId, joinUrl: meeting.join_url, meetingId: String(meeting.id) }
}
