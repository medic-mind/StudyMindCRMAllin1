// Summer Camp router. Read-only feeds for the live, view-only "Summer Camps"
// surface (roster + fill + weekly timetables) the sales team uses. CLAUDE.md
// §27. All staff may read; nothing here mutates, so no audit context.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { createClientFromConfig } from '@studymind/integration-summer-camp/client'

import { protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

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
})
