// Admin → Integrations status. Read-only summary for Settings dashboard.
// CLAUDE.md §11, §13, §14, §17.

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

// Integrations dashboard is admin-tier (ADR 0014).
const READ_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
])

const PROVIDERS = [
  'stripe',
  'gocardless',
  'aircall',
  'trengo',
  'slack',
  'asana',
  'gmail',
  'booking',
  'lead',
] as const

export const adminIntegrationsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!READ_ROLES.has(user.role)) {
      throw new TRPCError({ code: 'FORBIDDEN' })
    }

    // Last received ProviderEvent per provider.
    const lastEvents = await Promise.all(
      PROVIDERS.map(async (provider) => {
        const row = await ctx.db.providerEvent.findFirst({
          where: { provider },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true, type: true, eventId: true },
        })
        return { provider, last: row }
      }),
    )

    // Gmail per-agent watch expiry (CLAUDE.md §14, §17.1).
    const gmailMailboxes = await ctx.db.gmailMailbox.findMany({
      where: { deletedAt: null },
      select: { agentId: true, address: true, watchExpiresAt: true },
      take: 25,
      orderBy: { watchExpiresAt: 'asc' },
    })
    const now = Date.now()
    const gmailExpiringSoon = gmailMailboxes.filter(
      (m) => m.watchExpiresAt !== null && m.watchExpiresAt.getTime() - now < 1000 * 60 * 60 * 24,
    ).length

    // Asana webhooks registered (one per project).
    const asanaWebhookCount = await ctx.db.asanaWebhook.count()

    return {
      providers: lastEvents.map((p) => ({
        provider: p.provider,
        lastReceivedAt: p.last?.receivedAt ?? null,
        lastEventType: p.last?.type ?? null,
        lastEventId: p.last?.eventId ?? null,
      })),
      gmail: {
        connectedAgents: gmailMailboxes.length,
        expiringSoon: gmailExpiringSoon,
        mailboxes: gmailMailboxes.map((m) => ({
          agentId: m.agentId,
          address: m.address,
          watchExpiresAt: m.watchExpiresAt,
        })),
      },
      asana: {
        webhooks: asanaWebhookCount,
      },
    }
  }),

  /**
   * Synthetic ping that proves the ProviderEvent persistence path is
   * healthy end-to-end. Admin-only and audited. Does NOT call the live
   * provider API or forge a signature — instead it inserts a sentinel
   * ProviderEvent row of type `test.synthetic` so the dashboard's
   * "last received" timestamp updates and the row appears in audit logs.
   */
  test: auditedProcedure
    .input(z.object({ provider: z.enum(PROVIDERS) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (user.role !== 'ceo' && user.role !== 'senior_manager') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'admin only' })
      }
      const eventId = `synthetic-${createId()}`
      const row = await ctx.db.providerEvent.create({
        data: {
          id: createId(),
          provider: input.provider,
          eventId,
          type: 'test.synthetic',
          raw: { source: 'admin.integrations.test', actorId: user.id } as object,
          receivedAt: new Date(),
        },
      })
      await ctx.audit({
        action: 'admin.integration_tested',
        target: { type: 'ProviderEvent', id: row.id },
        after: { provider: input.provider, eventId },
      })
      return { provider: input.provider, eventId }
    }),
})
