// Team tRPC router. CLAUDE.md §20 — CEO + Senior Manager own Settings, so
// team CRUD + membership management are gated to that tier. Listing and
// reads are open to any authenticated user so task UIs can filter.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { TeamCreateInput, TeamUpdateInput } from '@studymind/core/team'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const TEAM_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
])

function assertCanManageTeams(role: UserRole): void {
  if (!TEAM_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only CEO and Senior Manager can manage teams',
    })
  }
}

export const teamRouter = router({
  // A small user directory for assignment / @mention pickers across the app
  // (card assignee, team + mail-account members, conversation @mentions).
  // Active users only.
  assignableUsers: protectedProcedure
    .input(z.object({ q: z.string().trim().min(1).max(80).optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.user.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          ...(input.q
            ? {
                OR: [
                  { email: { contains: input.q, mode: 'insensitive' as const } },
                  { name: { contains: input.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: { email: 'asc' },
        take: 50,
        select: { id: true, email: true, name: true },
      })
      return rows
    }),

  list: protectedProcedure
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
        })
        .default({ includeArchived: false }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.team.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { members: true } } },
      })
      return rows.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        description: t.description,
        memberCount: t._count.members,
        archived: t.archivedAt != null,
      }))
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const team = await ctx.db.team.findUnique({
        where: { id: input.id },
        include: {
          members: {
            include: {
              // Pull the user via a separate find so we don't fight the
              // optional relation. Done lazily below to avoid an N+1 issue:
              // a single fetch is enough since team membership is small.
            },
          },
        },
      })
      if (!team) throw new TRPCError({ code: 'NOT_FOUND' })
      const userIds = team.members.map((m) => m.userId)
      const users =
        userIds.length > 0
          ? await ctx.db.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, email: true, name: true },
            })
          : []
      const userMap = new Map(users.map((u) => [u.id, u]))
      return {
        id: team.id,
        name: team.name,
        color: team.color,
        description: team.description,
        archived: team.archivedAt != null,
        members: team.members.map((m) => ({
          id: m.id,
          userId: m.userId,
          email: userMap.get(m.userId)?.email ?? null,
          name: userMap.get(m.userId)?.name ?? null,
        })),
      }
    }),

  create: auditedProcedure
    .input(TeamCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageTeams(user.role)
      const id = createId()
      const created = await ctx.db.team.create({
        data: {
          id,
          name: input.name,
          color: input.color ?? null,
          description: input.description ?? null,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'team.created',
        target: { type: 'Team', id: created.id },
        after: created,
      })
      return { id: created.id }
    }),

  update: auditedProcedure
    .input(TeamUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageTeams(user.role)
      const before = await ctx.db.team.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.team.update({
        where: { id: input.id },
        data: {
          name: input.name ?? undefined,
          color: input.color,
          description: input.description,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'team.updated',
        target: { type: 'Team', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageTeams(user.role)
      const before = await ctx.db.team.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.team.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'team.archived',
        target: { type: 'Team', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageTeams(user.role)
      const before = await ctx.db.team.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.team.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'team.restored',
        target: { type: 'Team', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  addMember: auditedProcedure
    .input(z.object({ teamId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageTeams(user.role)
      const team = await ctx.db.team.findUnique({ where: { id: input.teamId } })
      if (!team) throw new TRPCError({ code: 'NOT_FOUND' })
      const id = createId()
      const member = await ctx.db.teamMember.upsert({
        where: {
          teamId_userId: { teamId: input.teamId, userId: input.userId },
        },
        create: {
          id,
          teamId: input.teamId,
          userId: input.userId,
          createdById: user.id,
        },
        update: {},
      })
      await ctx.audit({
        action: 'team.member_added',
        target: { type: 'Team', id: input.teamId },
        after: { memberId: member.id, userId: input.userId },
      })
      return { id: member.id }
    }),

  removeMember: auditedProcedure
    .input(z.object({ teamId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageTeams(user.role)
      const member = await ctx.db.teamMember.findUnique({
        where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
      })
      if (!member) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.teamMember.delete({ where: { id: member.id } })
      await ctx.audit({
        action: 'team.member_removed',
        target: { type: 'Team', id: input.teamId },
        before: { memberId: member.id, userId: input.userId },
      })
      return { id: member.id }
    }),

  // Tiny picker for the New Task / Team task-row UIs.
  pickList: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.team.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, color: true },
    })
    return rows
  }),
})
