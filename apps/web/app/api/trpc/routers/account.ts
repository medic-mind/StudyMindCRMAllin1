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
import { decryptFieldById, encryptField } from '@studymind/core/safeguarding'

import {
  auditedProcedure,
  auditedProcedureBypassMustReset,
  protectedProcedureBypassMustReset,
  requireUser,
  router,
} from '@/lib/trpc/builders'
import {
  buildRecoveryCodeRows,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotpCode,
} from '@/lib/auth/totp'

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
        totpEnabledAt: true,
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

  totp: router({
    /**
     * Stage 1 of TOTP enrolment: generate a fresh base32 secret and the
     * `otpauth://` URL for the user's Authenticator app. The secret is NOT
     * persisted yet — it round-trips through the client and is committed
     * only when `confirmSetup` succeeds with a matching code.
     */
    beginSetup: auditedProcedureBypassMustReset.mutation(async ({ ctx }) => {
      const actor = requireUser(ctx)
      const secret = generateTotpSecret()
      await ctx.audit({
        action: 'auth.totp_setup_started',
        target: { type: 'User', id: actor.id },
      })
      return {
        secret: secret.base32,
        otpauthUrl: secret.otpauthUrl(actor.email, 'StudyMind CRM'),
      }
    }),

    /**
     * Stage 2 of enrolment: verify the user's first code against the
     * candidate secret, then encrypt + persist the secret and generate
     * 10 recovery codes. The plaintext recovery codes are returned ONCE
     * for one-time display.
     */
    confirmSetup: auditedProcedureBypassMustReset
      .input(
        z.object({
          secret: z.string().min(16),
          code: z.string().min(6).max(8),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const actor = requireUser(ctx)
        if (!verifyTotpCode({ secret: input.secret, code: input.code })) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That code did not match. Try the latest code from your Authenticator app.',
          })
        }
        const existing = await ctx.db.user.findUnique({
          where: { id: actor.id },
          select: { totpEnabledAt: true },
        })
        if (existing?.totpEnabledAt) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Two-factor is already enabled. Disable it first to re-enrol.',
          })
        }

        const encrypted = await encryptField(ctx.db, {
          ownerType: 'User',
          ownerId: actor.id,
          fieldName: 'totp.secret',
          plaintext: input.secret,
          ctx: {
            actorId: actor.id,
            requestId: ctx.requestId,
            purpose: 'totp.enrolment',
          },
        })

        const { plain, hashes } = generateRecoveryCodes()
        const rows = buildRecoveryCodeRows(actor.id, hashes)

        await ctx.db.$transaction([
          ctx.db.user.update({
            where: { id: actor.id },
            data: {
              totpSecretCipherId: encrypted.id,
              totpEnabledAt: new Date(),
            },
          }),
          ctx.db.totpRecoveryCode.deleteMany({ where: { userId: actor.id } }),
          ctx.db.totpRecoveryCode.createMany({ data: rows }),
        ])

        await ctx.audit({
          action: 'auth.totp_enabled',
          target: { type: 'User', id: actor.id },
        })

        return { recoveryCodes: plain }
      }),

    /**
     * Disable MFA. Requires the current password AND a current TOTP code
     * (defence in depth: a stolen session alone cannot turn off MFA). The
     * encrypted secret + recovery codes are deleted in the same transaction.
     */
    disable: auditedProcedure
      .input(
        z.object({
          currentPassword: z.string().min(1),
          totpCode: z.string().min(6).max(8),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const actor = requireUser(ctx)
        const row = await ctx.db.user.findUnique({
          where: { id: actor.id },
          select: {
            id: true,
            passwordHash: true,
            totpSecretCipherId: true,
            totpEnabledAt: true,
          },
        })
        if (!row?.passwordHash) {
          throw new TRPCError({ code: 'CONFLICT', message: 'No password set.' })
        }
        if (!row.totpEnabledAt || !row.totpSecretCipherId) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Two-factor is not enabled.' })
        }
        const passOk = await verifyPassword(input.currentPassword, row.passwordHash)
        if (!passOk) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Current password is incorrect.',
          })
        }
        const secret = await decryptFieldById(ctx.db, {
          encryptedFieldId: row.totpSecretCipherId,
          actorId: actor.id,
          purpose: 'totp.disable',
          requestId: ctx.requestId,
        })
        if (!verifyTotpCode({ secret, code: input.totpCode })) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'That code did not match. Try the latest code from your Authenticator app.',
          })
        }

        await ctx.db.$transaction([
          ctx.db.user.update({
            where: { id: actor.id },
            data: { totpEnabledAt: null, totpSecretCipherId: null },
          }),
          ctx.db.totpRecoveryCode.deleteMany({ where: { userId: actor.id } }),
          // EncryptedField is keyed by (contactId, column); the encrypt path
          // stored ownerId as contactId, so we can scope by both for safety.
          ctx.db.encryptedField.deleteMany({
            where: { id: row.totpSecretCipherId },
          }),
        ])

        await ctx.audit({
          action: 'auth.totp_disabled',
          target: { type: 'User', id: actor.id },
        })

        return { ok: true as const }
      }),
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

  // Trengo per-agent token connect/reconnect. CLAUDE.md §11.
  // Tokens rotate every 90 days; each agent's outbound goes through their
  // own token so attribution is preserved. Validation calls Trengo `/me`
  // before persisting; an invalid token never lands in the DB.
  trengo: router({
    connect: auditedProcedure
      .input(z.object({ token: z.string().trim().min(8).max(2000) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        // Lazy import: keeps the Trengo connect helper out of the tRPC bundle
        // unless this procedure is actually invoked.
        const { connectTrengoToken, TrengoTokenInvalidError } = await import(
          '@studymind/integration-trengo/connect'
        )
        try {
          const result = await connectTrengoToken({
            agentId: user.id,
            token: input.token,
            requestId: ctx.requestId,
          })
          await ctx.audit({
            action: 'trengo.token_connect_requested',
            target: { type: 'User', id: user.id },
            after: { expiresAt: result.expiresAt.toISOString() },
          })
          return {
            expiresAt: result.expiresAt,
            trengoEmail: result.trengoEmail ?? null,
          }
        } catch (err) {
          if (err instanceof TrengoTokenInvalidError) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Trengo rejected the token. Generate a fresh one and try again.',
            })
          }
          throw err
        }
      }),
  }),
})
