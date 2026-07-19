// Zoom-link rotation (ADR 0035 amendment). Every active class whose link is
// older than its rotation interval (default 4 weeks) is ROTATED AUTOMATICALLY —
// a fresh open-to-all meeting is created, the old link dies, and the next
// weekly reminder email naturally carries the new one. A class with the
// per-class `zoomAutoRotate` toggle off — or a rotation that fails, or no Zoom
// credentials — falls back to the original behaviour: a reminder Task for a
// human. Idempotent: one open task per class, and rotation stamps
// zoomLinkUpdatedAt so a re-run is a no-op until the next interval.

import type { PrismaClient } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'

import { zoomRotationDue } from '@studymind/core/webinar'

import { loadZoomConfig } from './zoom-config'
import { openRotationTask, rotateClassZoomLink } from './zoom-service'

export interface ZoomRotationResult {
  classesChecked: number
  rotated: number
  tasksCreated: number
  failures: number
}

/** Rotate stale class links automatically; open a Task where we can't. */
export async function rotateDueZoomLinks(
  db: PrismaClient,
  now: Date,
): Promise<ZoomRotationResult> {
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
    tasksCreated: 0,
    failures: 0,
  }

  for (const cls of classes) {
    if (!zoomRotationDue(cls.zoomLinkUpdatedAt, cls.zoomRotateEveryWeeks, now)) continue

    // Auto-rotation needs the toggle on, credentials, and an existing link to
    // replace (a class that never had one is a setup decision for a human).
    if (cls.zoomAutoRotate && zoomConfigured && cls.zoomLink) {
      try {
        await rotateClassZoomLink(db, cls.id, {
          actorId: null,
          requestId: `zoom-rotate:${cls.id}:${createId()}`,
        })
        result.rotated += 1
        continue
      } catch {
        result.failures += 1
        if (await openRotationTask(db, cls, now, 'Automatic rotation FAILED — rotate it manually from the group page.')) {
          result.tasksCreated += 1
        }
        continue
      }
    }

    if (await openRotationTask(db, cls, now)) result.tasksCreated += 1
  }

  return result
}

/** Back-compat alias for the boundary registration. */
export const createZoomRotationTasks = rotateDueZoomLinks
