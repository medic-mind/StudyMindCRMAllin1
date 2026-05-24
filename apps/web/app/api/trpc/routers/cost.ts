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
  getCostReportMarkdown,
  listCostReports,
  signCostReportUrl,
} from '@studymind/core/observability/cost-reports-s3'
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

// Cost dashboard is finance-tier (ADR 0014).
const READ_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
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

  /**
   * History view backed by the S3 archive. Returns the latest N keys
   * with 7-day signed URLs and inline markdown for rendering. Falls
   * back to an empty list if the bucket is not configured (dev).
   */
  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(24).default(12) }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!READ_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      if (!process.env['S3_COST_REPORTS_BUCKET']) {
        return { reports: [] as Array<{
          weekIso: string
          s3Key: string
          signedUrl: string
          lastModified: string | null
          markdown: string
        }> }
      }
      const keys = await listCostReports(input.limit)
      const reports = await Promise.all(
        keys.map(async (k) => ({
          weekIso: k.weekIso,
          s3Key: k.s3Key,
          signedUrl: await signCostReportUrl(k.s3Key),
          lastModified: k.lastModified ? k.lastModified.toISOString() : null,
          markdown: await getCostReportMarkdown(k.s3Key),
        })),
      )
      return { reports }
    }),
})
