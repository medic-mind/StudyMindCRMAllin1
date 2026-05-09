// Admin → Users router. CLAUDE.md §20 (RBAC), §27 (audit context).
//
// Lists Users with their RoleAssignments. Mutations assign/revoke a role.
// Every mutation is audited. Admin only.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const ROLES = ['admin', 'ops_manager', 'agent', 'finance', 'dsl', 'read_only'] as const
const RoleEnum = z.enum(ROLES)

function assertAdmin(user: SessionUser) {
  if (user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'admin only' })
  }
}

export const adminUsersRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        q: z.string().trim().min(1).optional(),
        cursorId: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertAdmin(user)
      const where = {
        deletedAt: null,
        ...(input.q
          ? { email: { contains: input.q, mode: 'insensitive' as const } }
          : {}),
      }
      const rows = await ctx.db.user.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursorId ? { cursor: { id: input.cursorId }, skip: 1 } : {}),
        orderBy: { email: 'asc' },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          roleAssignments: { select: { id: true, role: true } },
        },
      })
      const hasMore = rows.length > input.limit
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        isActive: u.isActive,
        roles: u.roleAssignments.map((r) => ({ id: r.id, role: r.role as string })),
      }))
      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      }
    }),

  assignRole: auditedProcedure
    .input(z.object({ userId: z.string().min(1), role: RoleEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdmin(actor)
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })

      const existing = await ctx.db.roleAssignment.findUnique({
        where: { userId_role: { userId: input.userId, role: input.role } },
        select: { id: true },
      })
      if (existing) {
        await ctx.audit({
          action: 'admin.role.assign',
          target: { type: 'User', id: input.userId },
          before: { role: input.role, present: true },
          after: { role: input.role, present: true },
        })
        return { id: existing.id, alreadyPresent: true }
      }
      const id = createId()
      await ctx.db.roleAssignment.create({
        data: {
          id,
          userId: input.userId,
          role: input.role,
          createdById: actor.id,
          updatedById: actor.id,
        },
      })
      await ctx.audit({
        action: 'admin.role.assign',
        target: { type: 'User', id: input.userId },
        before: { role: input.role, present: false },
        after: { role: input.role, present: true },
      })
      return { id, alreadyPresent: false }
    }),

  revokeRole: auditedProcedure
    .input(z.object({ userId: z.string().min(1), role: RoleEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdmin(actor)
      // Guard: do not allow self-removal of the last admin (footgun).
      if (input.role === 'admin' && actor.id === input.userId) {
        const adminCount = await ctx.db.roleAssignment.count({
          where: { role: 'admin' },
        })
        if (adminCount <= 1) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'cannot revoke the last admin',
          })
        }
      }
      const existing = await ctx.db.roleAssignment.findUnique({
        where: { userId_role: { userId: input.userId, role: input.role } },
        select: { id: true },
      })
      if (!existing) {
        await ctx.audit({
          action: 'admin.role.revoke',
          target: { type: 'User', id: input.userId },
          before: { role: input.role, present: false },
          after: { role: input.role, present: false },
        })
        return { ok: true, alreadyAbsent: true }
      }
      await ctx.db.roleAssignment.delete({ where: { id: existing.id } })
      await ctx.audit({
        action: 'admin.role.revoke',
        target: { type: 'User', id: input.userId },
        before: { role: input.role, present: true },
        after: { role: input.role, present: false },
      })
      return { ok: true, alreadyAbsent: false }
    }),
})
