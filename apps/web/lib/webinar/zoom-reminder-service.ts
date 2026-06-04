// Zoom-link rotation reminder. Every active class whose link is older than its
// rotation interval (default 4 weeks) gets a Task asking the team to refresh it.
// Idempotent: we never open a second reminder while one is still open for the
// same class.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import { subjectLabel, levelLabel, zoomRotationDue, type WebinarLevel } from '@studymind/core/webinar'

export interface ZoomReminderResult {
  classesChecked: number
  tasksCreated: number
}

const TASK_PREFIX = '[Webinar] Update Zoom link'

/** Create rotation-reminder Tasks for classes whose link is stale. */
export async function createZoomRotationTasks(
  db: PrismaClient,
  now: Date,
): Promise<ZoomReminderResult> {
  const classes = await db.webinarClass.findMany({
    where: { active: true, deletedAt: null, cohort: { status: 'active' } },
    select: {
      id: true,
      title: true,
      subject: true,
      level: true,
      zoomLinkUpdatedAt: true,
      zoomRotateEveryWeeks: true,
    },
  })

  let tasksCreated = 0
  for (const cls of classes) {
    if (!zoomRotationDue(cls.zoomLinkUpdatedAt, cls.zoomRotateEveryWeeks, now)) continue

    const title = `${TASK_PREFIX} — ${subjectLabel(cls.subject)} ${levelLabel(
      cls.level as WebinarLevel,
    )}`
    // Skip if an open reminder for this class already exists.
    const existing = await db.task.findFirst({
      where: { title, status: { in: ['open', 'in_progress'] } },
      select: { id: true },
    })
    if (existing) continue

    await db.task.create({
      data: {
        id: createId(),
        title,
        description:
          `The Zoom link for "${cls.title}" is due for rotation ` +
          `(every ${cls.zoomRotateEveryWeeks} weeks). Update it in Webinars → ` +
          `Classes so next week's email carries the new link.`,
        status: 'open',
        dueAt: now,
      },
    })
    tasksCreated += 1
  }

  return { classesChecked: classes.length, tasksCreated }
}
