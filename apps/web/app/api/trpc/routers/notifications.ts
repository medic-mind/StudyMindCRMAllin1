// Notifications router. CLAUDE.md §20 (audit log is append-only; we use
// it as the notification source so nothing is fabricated), §27 (Zod IO).
//
// Phase 5 (ADR 0020): the bell now persists a real seen marker on the user
// row (`User.notificationsSeenAt`) and reports unread against it instead of
// the "actor !== user" heuristic Phase 1 used. `markSeen` is called by the
// bell on open; the column update is idempotent and audited as
// `auth.session_revoked`-tier benign (no audit row, kept off the per-user
// timeline so the bell does not echo its own state changes).

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
  /** Whether the row is unread for the current user — strictly newer than
   *  `User.notificationsSeenAt`. A row the user authored themselves is
   *  always read (the user knows they did it). */
  unread: boolean
}

export const notificationsRouter = router({
  list: protectedProcedure
    .input(NotificationsListInput)
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)

      // Read both the audit window and the user's last-seen marker in one
      // round-trip so the unread computation is consistent — a markSeen
      // racing with this query either lands before (everything read) or
      // after (everything still unread) but never mid-list.
      const [rows, userRow] = await Promise.all([
        ctx.db.auditLogEntry.findMany({
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
        }),
        ctx.db.user.findUnique({
          where: { id: user.id },
          select: { notificationsSeenAt: true },
        }),
      ])

      const seenAt = userRow?.notificationsSeenAt ?? null
      const items: NotificationItem[] = rows.map((r) => {
        const newer = seenAt ? r.occurredAt > seenAt : true
        return {
          id: r.id,
          action: r.action,
          actorId: r.actorId,
          targetType: r.targetType,
          targetId: r.targetId,
          purpose: r.purpose,
          occurredAt: r.occurredAt,
          // Self-authored rows are always read.
          unread: r.actorId !== user.id && newer,
        }
      })

      const unreadCount = items.filter((i) => i.unread).length
      return { items, unreadCount, seenAt }
    }),

  // ADR 0020 Phase 5 — record that the user opened the bell. Idempotent on
  // the timestamp; bell can call this repeatedly without cost. We don't
  // audit-write this (it would create the very rows the user is trying to
  // mark read — a loop) and we don't go through auditedProcedure for the
  // same reason. The DB write is the audit trail.
  markSeen: protectedProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      const now = new Date()
      await ctx.db.user.update({
        where: { id: user.id },
        data: { notificationsSeenAt: now },
        select: { id: true },
      })
      return { seenAt: now }
    }),
})
