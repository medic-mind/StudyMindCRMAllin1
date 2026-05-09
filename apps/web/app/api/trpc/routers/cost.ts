// Cost dashboard router. CLAUDE.md §32.
//
// Today this returns a live aggregation derived from the same pure helpers
// the Inngest cost-summary job uses, so the Reports → Cost page works in
// development without an S3 round-trip. Production reads will switch to
// the S3 archive once the worker boundary glue lands; the function shape
// stays the same.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  aggregateCostSummary,
  collectCostInputs,
  renderCostMarkdown,
} from '@studymind/jobs/cost-summary'

import {
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const READ_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'admin',
  'ops_manager',
  'finance',
])

export const costRouter = router({
  /** Latest summary for the current ISO week, computed on demand. */
  latest: protectedProcedure
    .input(z.object({ weeks: z.number().int().min(1).max(12).default(1) }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!READ_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }

      const reports: Array<{
        weekIso: string
        aiTotalUsd: number
        markdown: string
      }> = []
      const now = new Date()
      for (let i = 0; i < input.weeks; i++) {
        const t = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000)
        const inputs = await collectCostInputs(ctx.db as never, t)
        const summary = aggregateCostSummary({
          samples: inputs.samples,
          storage: inputs.storage,
          now: t,
        })
        reports.push({
          weekIso: summary.weekIso,
          aiTotalUsd: summary.aiTotalUsd,
          markdown: renderCostMarkdown(summary),
        })
      }
      return { reports }
    }),
})
