// Account namespace: change-password, sessions list/revoke. ADR 0010, chunk 7.
//
// changePassword uses auditedProcedureBypassMustReset because a user holding
// `mustResetPassword = true` must be allowed to set a new password — that's
// the entire point of the gate. Sessions list/revoke require the gate to be
// off (via plain auditedProcedure) so a force-reset user cannot inspect or
// kill sessions before they pick a new password.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  assertStrongPassword,
  hashPassword,
  verifyPassword,
} from '@studymind/core/auth/passwords'
import { BusinessError } from '@studymind/core/errors'

import {
  auditedProcedure,
  auditedProcedureBypassMustReset,
  protectedProcedureBypassMustReset,
  requireUser,
  router,
} from '@/lib/trpc/builders'

export const accountRouter = router({
  /** Profile summary for the /account landing page. */
  me: protectedProcedureBypassMustReset.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    const row = await ctx.db.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        name: true,
        lastSignInAt: true,
        mustResetPassword: true,
      },
    })
    if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
    return row
  }),

  changePassword: auditedProcedureBypassMustReset
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      const row = await ctx.db.user.findUnique({
        where: { id: actor.id },
        select: { id: true, passwordHash: true },
      })
      if (!row?.passwordHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'No password is set on this account.',
        })
      }
      const ok = await verifyPassword(input.currentPassword, row.passwordHash)
      if (!ok) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Current password is incorrect.',
        })
      }
      try {
        assertStrongPassword(input.newPassword)
      } catch (e) {
        if (e instanceof BusinessError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: e.message })
        }
        throw e
      }
      // Reuse-prevention: do not let the user "rotate" to the same password.
      if (await verifyPassword(input.newPassword, row.passwordHash)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'New password must differ from the current one.',
        })
      }

      const newHash = await hashPassword(input.newPassword)
      const currentSid = ctx.user?.sessionId ?? null

      await ctx.db.$transaction([
        ctx.db.user.update({
          where: { id: actor.id },
          data: {
            passwordHash: newHash,
            mustResetPassword: false,
            failedSignInAttempts: 0,
            lockedUntil: null,
          },
        }),
        // Force re-auth on every other device by deleting other Session rows.
        ctx.db.session.deleteMany({
          where: {
            userId: actor.id,
            ...(currentSid ? { NOT: { id: currentSid } } : {}),
          },
        }),
      ])

      await ctx.audit({
        action: 'auth.password_changed',
        target: { type: 'User', id: actor.id },
      })

      return { ok: true as const }
    }),

  sessions: router({
    list: auditedProcedure.query(async ({ ctx }) => {
      const actor = requireUser(ctx)
      const rows = await ctx.db.session.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
        },
      })
      // Audit-call enforcement: list is a query so the audit middleware does
      // not require it, but we record a single read so safeguarding-style
      // visibility is preserved.
      await ctx.audit({
        action: 'audit.logged',
        target: { type: 'User', id: actor.id },
        purpose: 'sessions.list',
      })
      return {
        items: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          ip: r.ipAddress,
          userAgent: r.userAgent,
          isCurrent: ctx.user?.sessionId === r.id,
        })),
      }
    }),

    revoke: auditedProcedure
      .input(z.object({ sessionId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const actor = requireUser(ctx)
        const row = await ctx.db.session.findUnique({
          where: { id: input.sessionId },
          select: { id: true, userId: true },
        })
        if (!row || row.userId !== actor.id) {
          // Same response whether the row is missing or belongs to someone
          // else — no enumeration of other users' session ids.
          throw new TRPCError({ code: 'NOT_FOUND' })
        }
        await ctx.db.session.delete({ where: { id: row.id } })
        await ctx.audit({
          action: 'auth.session_revoked',
          target: { type: 'Session', id: row.id },
        })
        return { ok: true as const }
      }),

    revokeAllOthers: auditedProcedure.mutation(async ({ ctx }) => {
      const actor = requireUser(ctx)
      const currentSid = ctx.user?.sessionId ?? null
      const result = await ctx.db.session.deleteMany({
        where: {
          userId: actor.id,
          ...(currentSid ? { NOT: { id: currentSid } } : {}),
        },
      })
      await ctx.audit({
        action: 'auth.sessions_revoked_all_others',
        target: { type: 'User', id: actor.id },
        after: { count: result.count },
      })
      return { ok: true as const, count: result.count }
    }),
  }),
})
