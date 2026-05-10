// OAuth admin namespace. Today: Gmail per-agent connect/disconnect status.
// ADR 0012, CLAUDE.md §14.

import { TRPCError } from '@trpc/server'

import {
  decryptFieldById,
  setKmsClient as _setKmsClient,
} from '@studymind/core/safeguarding'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import {
  stopWatchForUser,
} from '@studymind/integration-gmail/client'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

void _setKmsClient // keep tree-shake happy across import shapes

export const oauthRouter = router({
  gmail: router({
    /** Status surface for /settings/mailbox. */
    status: protectedProcedure.query(async ({ ctx }) => {
      const me = requireUser(ctx)
      const [user, mailbox] = await Promise.all([
        ctx.db.user.findUnique({
          where: { id: me.id },
          select: {
            gmailConnectionStatus: true,
            gmailRefreshTokenCipherId: true,
          },
        }),
        ctx.db.gmailMailbox.findUnique({
          where: { agentId: me.id },
          select: {
            address: true,
            historyId: true,
            watchExpiresAt: true,
            deletedAt: true,
          },
        }),
      ])
      return {
        status: user?.gmailConnectionStatus ?? null,
        connected: user?.gmailConnectionStatus === 'connected',
        address: mailbox && !mailbox.deletedAt ? mailbox.address : null,
        historyId: mailbox && !mailbox.deletedAt ? mailbox.historyId : null,
        watchExpiresAt:
          mailbox && !mailbox.deletedAt ? mailbox.watchExpiresAt : null,
      }
    }),

    /**
     * Disconnect: best-effort revoke at Google, stop the Pub/Sub watch,
     * delete the EncryptedField row, clear the User pointer + status.
     * Audited.
     */
    disconnect: auditedProcedure.mutation(async ({ ctx }) => {
      const me = requireUser(ctx)
      const user = await ctx.db.user.findUnique({
        where: { id: me.id },
        select: { gmailRefreshTokenCipherId: true },
      })

      if (!user?.gmailRefreshTokenCipherId) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No Gmail connection to disconnect.',
        })
      }

      const cipherId = user.gmailRefreshTokenCipherId

      // Best effort: read the refresh token so we can revoke it server-side.
      let refreshToken: string | null = null
      try {
        refreshToken = await decryptFieldById(ctx.db, {
          encryptedFieldId: cipherId,
          actorId: me.id,
          purpose: 'oauth_disconnect',
          requestId: ctx.requestId,
        })
      } catch {
        refreshToken = null
      }

      if (refreshToken) {
        try {
          await safeFetch('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ token: refreshToken }).toString(),
          })
        } catch {
          // Provider unreachable; continue — local state still reset below.
        }
      }

      // Stop the Pub/Sub watch (best-effort) and tombstone the mailbox row.
      try {
        await stopWatchForUser(me.id)
      } catch {
        // Already covered by stopWatchForUser internally; belt + braces.
      }

      // Delete the EncryptedField row + clear pointer + status.
      await ctx.db.$transaction([
        ctx.db.encryptedField.deleteMany({ where: { id: cipherId } }),
        ctx.db.user.update({
          where: { id: me.id },
          data: {
            gmailRefreshTokenCipherId: null,
            gmailConnectionStatus: 'disconnected',
          },
        }),
      ])

      await ctx.audit({
        action: 'gmail.oauth_disconnected',
        target: { type: 'User', id: me.id },
        before: { encryptedFieldId: cipherId },
      })

      return { ok: true as const }
    }),
  }),
})
