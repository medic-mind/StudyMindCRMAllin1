// Admin → Users router. CLAUDE.md §20 (RBAC), §27 (audit context), ADR 0009, ADR 0010.
//
// Manages user identity for the self-hosted auth flow:
//   - list / get with status (active | invited | deactivated | locked)
//   - invite (email-link based; user sets their own password on accept)
//   - assign / revoke roles, gated by canGrantRole / canRevokeRole
//   - deactivate / reactivate
//
// Every mutation is audited. The actor's primary role drives the role-grant
// matrix (admin cannot grant admin or super_admin; only super_admin can).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  canGrantRole,
  canRevokeRole,
  ROLES,
  type Role,
} from '@studymind/core/auth/policies'
import { assertNotLastSuperAdmin } from '@studymind/core/auth/guards'
import { generateToken, hashToken } from '@studymind/core/auth/passwords'
import { BusinessError } from '@studymind/core/errors'
import { logger } from '@studymind/core/logger'
import { sendEmail } from '@studymind/integration-resend'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const RoleEnum = z.enum(ROLES)

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function appUrl(): string {
  return (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

function assertAdminish(user: SessionUser): void {
  if (user.role !== 'admin' && user.role !== 'super_admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'admin only' })
  }
}

interface UserStatusInput {
  passwordHash: string | null
  emailVerifiedAt: Date | null
  deactivatedAt: Date | null
  lockedUntil: Date | null
}

function deriveStatus(u: UserStatusInput): 'active' | 'invited' | 'deactivated' | 'locked' {
  if (u.deactivatedAt) return 'deactivated'
  if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) return 'locked'
  if (!u.passwordHash) return 'invited'
  return 'active'
}

export const adminUsersRouter = router({
  /* ------------------------------------------------------------------ */
  /* list                                                                */
  /* ------------------------------------------------------------------ */
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().trim().min(1).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertAdminish(requireUser(ctx))
      const where = {
        deletedAt: null,
        ...(input.search
          ? {
              OR: [
                { email: { contains: input.search, mode: 'insensitive' as const } },
                { name: { contains: input.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      }
      const rows = await ctx.db.user.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { email: 'asc' },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          passwordHash: true,
          emailVerifiedAt: true,
          deactivatedAt: true,
          lockedUntil: true,
          lastSignInAt: true,
          roleAssignments: { select: { id: true, role: true } },
        },
      })
      const hasMore = rows.length > input.limit
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        isActive: u.isActive,
        lastSignInAt: u.lastSignInAt,
        status: deriveStatus(u),
        roles: u.roleAssignments.map((r) => ({ id: r.id, role: r.role as Role })),
      }))
      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      }
    }),

  /* ------------------------------------------------------------------ */
  /* get                                                                 */
  /* ------------------------------------------------------------------ */
  get: protectedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertAdminish(requireUser(ctx))
      const u = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          passwordHash: true,
          emailVerifiedAt: true,
          deactivatedAt: true,
          deactivationReason: true,
          lockedUntil: true,
          failedSignInAttempts: true,
          lastSignInAt: true,
          lastSignInIp: true,
          mustResetPassword: true,
          roleAssignments: { select: { id: true, role: true } },
          sessions: { select: { id: true } },
        },
      })
      if (!u) throw new TRPCError({ code: 'NOT_FOUND' })
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        isActive: u.isActive,
        deactivationReason: u.deactivationReason,
        lastSignInAt: u.lastSignInAt,
        lastSignInIp: u.lastSignInIp,
        mustResetPassword: u.mustResetPassword,
        failedSignInAttempts: u.failedSignInAttempts,
        sessionCount: u.sessions.length,
        status: deriveStatus(u),
        roles: u.roleAssignments.map((r) => ({ id: r.id, role: r.role as Role })),
      }
    }),

  /* ------------------------------------------------------------------ */
  /* invite                                                              */
  /* ------------------------------------------------------------------ */
  invite: auditedProcedure
    .input(
      z.object({
        email: z.string().email(),
        roles: z.array(RoleEnum).min(1),
        name: z.string().trim().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdminish(actor)
      const email = input.email.trim().toLowerCase()

      // Every requested role must be grantable by the actor.
      for (const role of input.roles) {
        if (!canGrantRole(actor.role, role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `cannot grant role: ${role}`,
          })
        }
      }

      const existing = await ctx.db.user.findUnique({ where: { email } })
      if (existing && existing.passwordHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A user with that email already exists.',
        })
      }

      const userId = existing?.id ?? createId()
      if (!existing) {
        await ctx.db.user.create({
          data: {
            id: userId,
            email,
            name: input.name ?? null,
            passwordHash: null,
            emailVerifiedAt: null,
            mustResetPassword: false,
            createdById: actor.id,
            updatedById: actor.id,
          },
        })
      } else if (input.name && !existing.name) {
        await ctx.db.user.update({
          where: { id: existing.id },
          data: { name: input.name, updatedById: actor.id },
        })
      }

      // Idempotently ensure each requested role is present.
      for (const role of input.roles) {
        const present = await ctx.db.roleAssignment.findUnique({
          where: { userId_role: { userId, role } },
          select: { id: true },
        })
        if (!present) {
          await ctx.db.roleAssignment.create({
            data: {
              id: createId(),
              userId,
              role,
              createdById: actor.id,
              updatedById: actor.id,
            },
          })
        }
      }

      // Issue an invite token (reusing EmailVerificationToken with a 7d TTL —
      // the accept-invite flow checks `passwordHash IS NULL` to distinguish).
      const rawToken = generateToken()
      await ctx.db.emailVerificationToken.create({
        data: {
          id: createId(),
          userId,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      })

      const link = `${appUrl()}/accept-invite?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`
      await sendEmail({
        to: email,
        subject: 'You have been invited to StudyMind CRM',
        body:
          `Hello${input.name ? ` ${input.name}` : ''},\n\n` +
          `${actor.email} has invited you to StudyMind CRM. ` +
          `Use the link below to set your password — it expires in 7 days.\n\n${link}\n\n` +
          `If you were not expecting this email, you can ignore it.\n\n— StudyMind CRM`,
      }).catch((err) => {
        logger.error({ err }, 'admin.users.invite.email_send_failed')
      })

      await ctx.audit({
        action: 'auth.user_invited',
        target: { type: 'User', id: userId },
        after: { email, roles: input.roles },
      })

      return { userId, email }
    }),

  /* ------------------------------------------------------------------ */
  /* resend invite                                                       */
  /* ------------------------------------------------------------------ */
  resendInvite: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdminish(actor)
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, email: true, name: true, passwordHash: true },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (user.passwordHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'User has already accepted their invite.',
        })
      }
      const rawToken = generateToken()
      await ctx.db.emailVerificationToken.create({
        data: {
          id: createId(),
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      })
      const link = `${appUrl()}/accept-invite?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(user.email)}`
      await sendEmail({
        to: user.email,
        subject: 'Your StudyMind CRM invite',
        body:
          `Hello${user.name ? ` ${user.name}` : ''},\n\n` +
          `Here is a fresh invite link, valid for 7 days:\n\n${link}\n\n— StudyMind CRM`,
      }).catch((err) => {
        logger.error({ err }, 'admin.users.invite.email_send_failed')
      })
      await ctx.audit({
        action: 'auth.user_invite_resent',
        target: { type: 'User', id: user.id },
      })
      return { ok: true }
    }),

  /* ------------------------------------------------------------------ */
  /* cancel invite                                                       */
  /* ------------------------------------------------------------------ */
  cancelInvite: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdminish(actor)
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, passwordHash: true },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (user.passwordHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Cannot cancel — user has already accepted.',
        })
      }
      // Invalidate any outstanding tokens.
      await ctx.db.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      })
      // Soft-delete the row so they no longer appear in lists.
      await ctx.db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date(), updatedById: actor.id },
      })
      await ctx.db.roleAssignment.deleteMany({ where: { userId: user.id } })
      await ctx.audit({
        action: 'auth.user_invite_cancelled',
        target: { type: 'User', id: user.id },
      })
      return { ok: true }
    }),

  /* ------------------------------------------------------------------ */
  /* assignRole                                                          */
  /* ------------------------------------------------------------------ */
  assignRole: auditedProcedure
    .input(z.object({ userId: z.string().min(1), role: RoleEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdminish(actor)
      if (!canGrantRole(actor.role, input.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `cannot grant role: ${input.role}`,
        })
      }
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
          action: 'auth.role_granted',
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
        action: 'auth.role_granted',
        target: { type: 'User', id: input.userId },
        before: { role: input.role, present: false },
        after: { role: input.role, present: true },
      })
      return { id, alreadyPresent: false }
    }),

  /* ------------------------------------------------------------------ */
  /* revokeRole                                                          */
  /* ------------------------------------------------------------------ */
  revokeRole: auditedProcedure
    .input(z.object({ userId: z.string().min(1), role: RoleEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdminish(actor)
      if (!canRevokeRole(actor.role, input.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `cannot revoke role: ${input.role}`,
        })
      }
      // Self-demotion locked for elevated roles.
      if (
        actor.id === input.userId &&
        (input.role === 'admin' || input.role === 'super_admin')
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Cannot revoke your own admin or super_admin role.',
        })
      }
      // Last super_admin guard.
      if (input.role === 'super_admin') {
        try {
          await assertNotLastSuperAdmin(ctx.db, input.userId)
        } catch (e) {
          if (e instanceof BusinessError && e.code === 'LAST_SUPER_ADMIN') {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'cannot revoke the last super_admin',
            })
          }
          throw e
        }
      }

      const existing = await ctx.db.roleAssignment.findUnique({
        where: { userId_role: { userId: input.userId, role: input.role } },
        select: { id: true },
      })
      if (!existing) {
        await ctx.audit({
          action: 'auth.role_revoked',
          target: { type: 'User', id: input.userId },
          before: { role: input.role, present: false },
          after: { role: input.role, present: false },
        })
        return { ok: true, alreadyAbsent: true }
      }
      await ctx.db.roleAssignment.delete({ where: { id: existing.id } })
      await ctx.audit({
        action: 'auth.role_revoked',
        target: { type: 'User', id: input.userId },
        before: { role: input.role, present: true },
        after: { role: input.role, present: false },
      })
      return { ok: true, alreadyAbsent: false }
    }),

  /* ------------------------------------------------------------------ */
  /* deactivate                                                          */
  /* ------------------------------------------------------------------ */
  deactivate: auditedProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().trim().min(1),
        reassignToUserId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdminish(actor)
      if (actor.id === input.userId) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Cannot deactivate yourself.',
        })
      }
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: {
          id: true,
          deactivatedAt: true,
          roleAssignments: { select: { id: true, role: true } },
        },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (user.deactivatedAt) {
        return { ok: true, alreadyDeactivated: true }
      }

      // If the actor cannot revoke any of the target's roles, refuse.
      for (const ra of user.roleAssignments) {
        if (!canRevokeRole(actor.role, ra.role as Role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `cannot deactivate user with role: ${ra.role}`,
          })
        }
      }

      // Last super_admin guard if the target is a super_admin.
      if (user.roleAssignments.some((r) => r.role === 'super_admin')) {
        try {
          await assertNotLastSuperAdmin(ctx.db, user.id)
        } catch (e) {
          if (e instanceof BusinessError && e.code === 'LAST_SUPER_ADMIN') {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'cannot deactivate the last super_admin',
            })
          }
          throw e
        }
      }

      // If user is the assigned DSL on any active SafeguardingFlag, require
      // a reassign target.
      const activeDslFlags = await ctx.db.safeguardingFlag.findMany({
        where: {
          dslUserId: user.id,
          deletedAt: null,
          closedAt: null,
        },
        select: { id: true },
      })
      if (activeDslFlags.length > 0 && !input.reassignToUserId) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'User is assigned DSL on active flags; reassignToUserId required.',
        })
      }
      if (activeDslFlags.length > 0 && input.reassignToUserId) {
        const replacement = await ctx.db.user.findFirst({
          where: {
            id: input.reassignToUserId,
            deletedAt: null,
            deactivatedAt: null,
            roleAssignments: { some: { role: 'dsl' } },
          },
          select: { id: true },
        })
        if (!replacement) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'reassignToUserId must be an active DSL user.',
          })
        }
        await ctx.db.safeguardingFlag.updateMany({
          where: { id: { in: activeDslFlags.map((f) => f.id) } },
          data: { dslUserId: input.reassignToUserId, updatedById: actor.id },
        })
      }

      const now = new Date()
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          deactivatedAt: now,
          deactivationReason: input.reason,
          isActive: false,
          updatedById: actor.id,
        },
      })
      await ctx.db.roleAssignment.deleteMany({ where: { userId: user.id } })
      await ctx.db.session.deleteMany({ where: { userId: user.id } })

      await ctx.audit({
        action: 'auth.user_deactivated',
        target: { type: 'User', id: user.id },
        after: {
          reason: input.reason,
          reassignedFlags: activeDslFlags.length,
        },
      })
      return { ok: true, alreadyDeactivated: false }
    }),

  /* ------------------------------------------------------------------ */
  /* reactivate                                                          */
  /* ------------------------------------------------------------------ */
  reactivate: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertAdminish(actor)
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, deactivatedAt: true },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (!user.deactivatedAt) {
        return { ok: true, alreadyActive: true }
      }
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          deactivatedAt: null,
          deactivationReason: null,
          isActive: true,
          updatedById: actor.id,
        },
      })
      await ctx.audit({
        action: 'auth.user_reactivated',
        target: { type: 'User', id: user.id },
      })
      return { ok: true, alreadyActive: false }
    }),
})
