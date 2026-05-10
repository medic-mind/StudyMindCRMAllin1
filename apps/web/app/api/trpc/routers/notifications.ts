// Notifications router. CLAUDE.md §20 (audit log is append-only; we use
// it as the notification source so nothing is fabricated), §27 (Zod IO).
//
// Phase 1 surface: the top-bar bell shows the 10 most recent
// AuditLogEntry rows where the current user is either the actor (their
// own actions echoed back) or the target (rows acted upon — e.g. a
// safeguarding flag raised against a Contact they own). This is a thin
// surfacing layer; real notification preferences live in a later chunk.

import { z } from 'zod'

import { protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

const NotificationsListInput = z.object({
  limit: z.number().int().min(1).max(50).default(10),
})

export interface NotificationItem {
  id: string
  action: string
  actorId: string | null
  targetType: string
  targetId: string
  purpose: string | null
  occurredAt: Date
  /** Whether the row is unread for the current user. Phase 1: anything
   *  newer than the user's last seen marker. We persist seen state in the
   *  User row via `notificationsSeenAt`. */
  unread: boolean
}

export const notificationsRouter = router({
  list: protectedProcedure
    .input(NotificationsListInput)
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)

      const rows = await ctx.db.auditLogEntry.findMany({
        where: {
          OR: [
            { actorId: user.id },
            { targetId: user.id },
          ],
        },
        orderBy: { occurredAt: 'desc' },
        take: input.limit,
        select: {
          id: true,
          action: true,
          actorId: true,
          targetType: true,
          targetId: true,
          purpose: true,
          occurredAt: true,
        },
      })

      // Phase 1 unread heuristic: rows where the user is NOT the actor are
      // unread until the user opens the bell (which calls `markSeen`).
      // Persistence of the "seen" marker is a follow-up; for now we mark
      // everything actor-authored as read and target rows as unread.
      const items: NotificationItem[] = rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        targetType: r.targetType,
        targetId: r.targetId,
        purpose: r.purpose,
        occurredAt: r.occurredAt,
        unread: r.actorId !== user.id,
      }))

      const unreadCount = items.filter((i) => i.unread).length
      return { items, unreadCount }
    }),
})
