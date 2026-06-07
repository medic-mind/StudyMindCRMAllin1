// Summer Camp router. Read-only feeds for the live, view-only "Summer Camps"
// surface (roster + fill + weekly timetables) the sales team uses. CLAUDE.md
// §27. All staff may read; nothing here mutates, so no audit context.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { createClientFromConfig } from '@studymind/integration-summer-camp/client'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

// Importing all current bookings creates Contacts — gate to the admin tier,
// matching the other backfill triggers (ADR 0017 / conversation-head backfill).
const BACKFILL_ROLES: ReadonlySet<SessionUser['role']> = new Set(['ceo', 'senior_manager'])

export const summerCampRouter = router({
  // Whether the camp app feeds are configured, so the UI can render a clear
  // "not connected" state instead of an error.
  status: protectedProcedure.query(({ ctx }) => {
    requireUser(ctx)
    return { connected: createClientFromConfig() !== null }
  }),

  camps: protectedProcedure
    .input(z.object({ year: z.number().int().min(2000).max(2100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      const client = createClientFromConfig()
      if (!client) return { connected: false as const, feed: null }
      try {
        const feed = await client.getCamps(input?.year)
        return { connected: true as const, feed }
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'summer camp feed unavailable',
        })
      }
    }),

  timetable: protectedProcedure
    .input(z.object({ campId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      const client = createClientFromConfig()
      if (!client) return { connected: false as const, feed: null }
      try {
        const feed = await client.getTimetable(input?.campId ?? null)
        return { connected: true as const, feed }
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'summer camp timetable unavailable',
        })
      }
    }),

  // Import ALL current camp bookings into the CRM (one-shot, background).
  // Fires the self-rescheduling Inngest backfill; the recurring sync then
  // keeps the CRM in step. CEO + Senior Manager only.
  backfill: auditedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!BACKFILL_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
    if (!createClientFromConfig()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Summer Camp app is not connected.' })
    }
    const { inngest } = await import('@studymind/jobs')
    const jobId = `scbf_${Date.now().toString(36)}_${user.id.slice(-6)}`
    await inngest.send({ name: 'summer-camp/backfill-bookings.requested', data: { jobId } })
    await ctx.audit({
      action: 'summer_camp.backfill_requested',
      target: { type: 'System', id: jobId },
      after: { initiatedBy: user.id },
    })
    return { jobId }
  }),
})
