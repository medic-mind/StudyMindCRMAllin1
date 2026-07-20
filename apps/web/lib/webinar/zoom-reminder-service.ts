// Zoom-link rotation (ADR 0035 amendment; task-free since the 2026-07 redesign).
// Every active class whose link is older than its rotation interval (default 4
// weeks) is ROTATED AUTOMATICALLY — a fresh open-to-all meeting is created, the
// old link dies, and the next weekly reminder email carries the new one. A
// class with the per-class `zoomAutoRotate` toggle off — or a rotation that
// fails, or no Zoom credentials — falls back to a REMINDER: it is emailed to the
// single configured "assigned person" (Webinars → Settings) and surfaces in the
// on-system reminder panel (`listZoomRotationDue`). Idempotent: rotation stamps
// zoomLinkUpdatedAt so a re-run is a no-op until the next interval; the reminder
// email goes out at most once per weekly tick.

import type { PrismaClient } from '@prisma/client'

import { sendSystemEmail } from '@studymind/integration-gmail/system-send'
import { levelLabel, subjectLabel, zoomRotationDue } from '@studymind/core/webinar'

import { loadZoomConfig } from './zoom-config'
import { rotateClassZoomLink } from './zoom-service'

export interface ZoomRotationResult {
  classesChecked: number
  rotated: number
  /** 1 when the digest email went out, 0 when there was nobody to email / nothing due. */
  remindersEmailed: number
  /** How many classes need a human to rotate the link (auto-rotate off/failed). */
  needsAttention: number
  failures: number
}

interface DueClass {
  id: string
  title: string
  subject: string
  level: string
  zoomRotateEveryWeeks: number
  reason: string
}

/** Rotate stale class links automatically; email the assigned person where we
 *  can't (and surface those classes in the on-system reminder). */
export async function runZoomRotation(db: PrismaClient, now: Date): Promise<ZoomRotationResult> {
  const classes = await db.webinarClass.findMany({
    where: { active: true, deletedAt: null, cohort: { status: 'active' } },
    select: {
      id: true,
      title: true,
      subject: true,
      level: true,
      zoomLink: true,
      zoomLinkUpdatedAt: true,
      zoomRotateEveryWeeks: true,
      zoomAutoRotate: true,
    },
  })

  const zoomConfigured = (await loadZoomConfig(db)) !== null
  const result: ZoomRotationResult = {
    classesChecked: classes.length,
    rotated: 0,
    remindersEmailed: 0,
    needsAttention: 0,
    failures: 0,
  }
  const needsAttention: DueClass[] = []

  for (const cls of classes) {
    if (!zoomRotationDue(cls.zoomLinkUpdatedAt, cls.zoomRotateEveryWeeks, now)) continue

    // Auto-rotation needs the toggle on, credentials, and an existing link to
    // replace (a class that never had one is a setup decision for a human).
    if (cls.zoomAutoRotate && zoomConfigured && cls.zoomLink) {
      try {
        await rotateClassZoomLink(db, cls.id, {
          actorId: null,
          requestId: `zoom-rotate:${cls.id}:${now.getTime()}`,
        })
        result.rotated += 1
        continue
      } catch {
        result.failures += 1
        needsAttention.push({
          id: cls.id,
          title: cls.title,
          subject: cls.subject,
          level: cls.level,
          zoomRotateEveryWeeks: cls.zoomRotateEveryWeeks,
          reason: 'Automatic rotation FAILED — rotate it manually from the group page.',
        })
        continue
      }
    }

    needsAttention.push({
      id: cls.id,
      title: cls.title,
      subject: cls.subject,
      level: cls.level,
      zoomRotateEveryWeeks: cls.zoomRotateEveryWeeks,
      reason: !zoomConfigured
        ? 'Zoom is not connected — rotate the link manually.'
        : !cls.zoomLink
          ? 'No Zoom link yet — set one up on the group page.'
          : 'Auto-rotation is off for this group — rotate the link manually.',
    })
  }

  result.needsAttention = needsAttention.length
  if (needsAttention.length > 0) {
    result.remindersEmailed = await emailRotationReminder(db, needsAttention)
  }
  return result
}

/** Email the single configured "assigned person" a digest of the class links
 *  that need rotating. Returns 1 when an email was sent, 0 when there is no
 *  recipient configured (Webinars → Settings) or the send failed. */
async function emailRotationReminder(db: PrismaClient, due: DueClass[]): Promise<number> {
  const settings = await db.webinarSettings.findUnique({
    where: { id: 'webinar' },
    select: { rotationReminderEmail: true, senderMailboxUserId: true, senderAddress: true },
  })
  const to = settings?.rotationReminderEmail?.trim()
  if (!to) return 0

  const lines = due.map(
    (c) =>
      `• ${subjectLabel(c.subject)} ${levelLabel(c.level)} — "${c.title}" (rotates every ${c.zoomRotateEveryWeeks} weeks)\n    ${c.reason}`,
  )
  const text =
    `${due.length} weekly-class Zoom link${due.length === 1 ? '' : 's'} ` +
    `need${due.length === 1 ? 's' : ''} rotating:\n\n${lines.join('\n\n')}\n\n` +
    `Update each link in Webinars → Groups so next week's class email carries the new one.`

  try {
    const send = await sendSystemEmail({
      to,
      subject: `Zoom links to rotate — ${due.length} weekly class${due.length === 1 ? '' : 'es'}`,
      text,
      fromAgentId: settings?.senderMailboxUserId ?? undefined,
      fromAddress: settings?.senderAddress ?? undefined,
      requestId: `zoom-rotation-reminder:${due.map((c) => c.id).join(',')}`,
    })
    return send.status === 'sent' ? 1 : 0
  } catch {
    return 0
  }
}

/** The on-system reminder: every active class whose Zoom link is due for
 *  rotation right now (derived, never stored). Surfaced on the Webinars
 *  overview so the reminder is visible in-app as well as emailed. */
export async function listZoomRotationDue(
  db: PrismaClient,
  now: Date,
): Promise<
  Array<{
    id: string
    title: string
    subject: string
    level: string
    zoomRotateEveryWeeks: number
    zoomLinkUpdatedAt: Date | null
    autoRotate: boolean
    hasLink: boolean
  }>
> {
  const classes = await db.webinarClass.findMany({
    where: { active: true, deletedAt: null, cohort: { status: 'active' } },
    select: {
      id: true,
      title: true,
      subject: true,
      level: true,
      zoomLink: true,
      zoomLinkUpdatedAt: true,
      zoomRotateEveryWeeks: true,
      zoomAutoRotate: true,
    },
  })
  return classes
    .filter((c) => zoomRotationDue(c.zoomLinkUpdatedAt, c.zoomRotateEveryWeeks, now))
    .map((c) => ({
      id: c.id,
      title: c.title,
      subject: c.subject,
      level: c.level,
      zoomRotateEveryWeeks: c.zoomRotateEveryWeeks,
      zoomLinkUpdatedAt: c.zoomLinkUpdatedAt,
      autoRotate: c.zoomAutoRotate,
      hasLink: Boolean(c.zoomLink),
    }))
}
