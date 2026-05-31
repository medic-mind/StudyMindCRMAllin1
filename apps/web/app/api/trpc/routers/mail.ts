// /mail client data (ADR 0021 Phase 4). Email-focused views over the unified
// Conversation head (provider='email'). Staff-gated like the Comms Centre; the
// thread detail reuses `inbox.conversations.get` (it already renders email).
//
// `accounts` powers the folder rail / account filter and respects MailAccount
// visibility (own personal + shared the caller belongs to; Manager+ sees all),
// mirroring `mailAccount.list`. `threads.list` is the message list.

import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const STAFF_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const MANAGE_SHARED_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

function assertStaff(role: UserRole): void {
  if (!STAFF_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Mail is staff-only.' })
  }
}

export const mailRouter = router({
  /**
   * Email accounts visible to the caller, for the folder rail / account filter.
   * Same visibility as mailAccount.list: own personal + shared the caller
   * belongs to; Manager+ sees all. Only mail providers are returned.
   */
  accounts: protectedProcedure.query(async ({ ctx }) => {
    const me = requireUser(ctx)
    assertStaff(me.role)
    let where: Record<string, unknown> = { deletedAt: null }
    if (!MANAGE_SHARED_ROLES.has(me.role)) {
      const memberOf = await ctx.db.mailAccountMember.findMany({
        where: { userId: me.id },
        select: { mailAccountId: true },
      })
      where = {
        deletedAt: null,
        OR: [
          { ownerUserId: me.id },
          { id: { in: memberOf.map((m) => m.mailAccountId) } },
        ],
      }
    }
    const rows = await ctx.db.mailAccount.findMany({
      where,
      orderBy: [{ ownerKind: 'asc' }, { address: 'asc' }],
      select: {
        id: true,
        address: true,
        displayName: true,
        ownerKind: true,
        status: true,
      },
    })
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      displayName: r.displayName,
      ownerKind: r.ownerKind,
      status: r.status,
    }))
  }),

  threads: router({
    /**
     * Email conversation heads, newest first. Optional account filter; an
     * `unread` filter for the unread folder. Keyset paginated on
     * (lastMessageAt, id) like the Comms Centre.
     */
    list: protectedProcedure
      .input(
        z.object({
          mailAccountId: z.string().nullish(),
          filter: z.enum(['all', 'unread']).default('all'),
          cursor: z
            .object({ id: z.string(), lastMessageAt: z.date() })
            .nullish(),
          limit: z.number().int().min(1).max(100).default(50),
        }),
      )
      .query(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertStaff(me.role)

        const where: Record<string, unknown> = { provider: 'email' }
        if (input.mailAccountId) where['mailAccountId'] = input.mailAccountId
        if (input.filter === 'unread') where['unreadCount'] = { gt: 0 }
        if (input.cursor) {
          where['OR'] = [
            { lastMessageAt: { lt: input.cursor.lastMessageAt } },
            {
              AND: [
                { lastMessageAt: input.cursor.lastMessageAt },
                { id: { lt: input.cursor.id } },
              ],
            },
          ]
        }

        const rows = await ctx.db.conversation.findMany({
          where,
          orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            contactId: true,
            subject: true,
            unreadCount: true,
            status: true,
            lastMessageAt: true,
            mailAccountId: true,
            contact: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
            mailAccount: { select: { address: true } },
          },
        })

        const hasMore = rows.length > input.limit
        const sliced = hasMore ? rows.slice(0, input.limit) : rows
        const items = sliced.map((r) => ({
          id: r.id,
          contactId: r.contactId,
          subject: r.subject,
          unreadCount: r.unreadCount,
          status: r.status,
          lastMessageAt: r.lastMessageAt,
          accountAddress: r.mailAccount?.address ?? null,
          contactName: r.contact
            ? [r.contact.firstName, r.contact.lastName]
                .filter((x): x is string => !!x)
                .join(' ') ||
              r.contact.email ||
              null
            : null,
        }))
        const last = sliced[sliced.length - 1]
        const nextCursor =
          hasMore && last
            ? { id: last.id, lastMessageAt: last.lastMessageAt }
            : null
        return { items, nextCursor }
      }),
  }),
})
