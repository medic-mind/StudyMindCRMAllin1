// LAContract router. CLAUDE.md §27, §43.2-§43.4.
//
// Role-gated: account leads (ops_manager / admin) and finance can read; only
// admin / ops_manager can create. Progress-report signoff is account_lead
// (ops_manager) or admin.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  generateLAInvoice,
  generateProgressReportDraft,
  markLAInvoicePaid,
  markLAInvoiceSent,
  signoffProgressReport,
} from '@studymind/core/lacontract'

import {
  auditedProcedure,
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
const WRITE_ROLES: ReadonlySet<SessionUser['role']> = new Set(['admin', 'ops_manager'])
const FINANCE_ROLES: ReadonlySet<SessionUser['role']> = new Set(['admin', 'finance'])

function assertRead(user: SessionUser): void {
  if (!READ_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'cannot view LA contracts' })
  }
}

function assertReportSignoff(user: SessionUser): void {
  if (!WRITE_ROLES.has(user.role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'only an account lead (ops_manager) or admin may sign off reports',
    })
  }
}

function assertFinance(user: SessionUser): void {
  if (!FINANCE_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'finance role required' })
  }
}

export const lacontractRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    assertRead(requireUser(ctx))
    const contracts = await ctx.db.lAContract.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        laName: true,
        reference: true,
        contractValueMinor: true,
        startDate: true,
        endDate: true,
        reportingCadence: true,
        accountLeadId: true,
        _count: { select: { families: true, invoices: true, reports: true } },
      },
      orderBy: { startDate: 'desc' },
      take: 100,
    })
    return contracts
  }),

  reports: router({
    list: protectedProcedure
      .input(z.object({ contractId: z.string() }))
      .query(async ({ ctx, input }) => {
        assertRead(requireUser(ctx))
        const reports = await ctx.db.lAProgressReport.findMany({
          where: { contractId: input.contractId },
          select: {
            id: true,
            familyId: true,
            periodStart: true,
            periodEnd: true,
            state: true,
            signedAt: true,
            pdfS3Key: true,
          },
          orderBy: { periodStart: 'desc' },
        })
        return reports
      }),

    signoff: auditedProcedure
      .input(
        z.object({
          reportId: z.string(),
          decision: z.enum(['approve', 'reject']),
          rationale: z.string().max(2000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertReportSignoff(user)
        const result = await signoffProgressReport(
          ctx.db,
          {
            reportId: input.reportId,
            signerId: user.id,
            decision: input.decision,
            ...(input.rationale ? { rationale: input.rationale } : {}),
          },
          { actorId: user.id, requestId: ctx.requestId },
        )
        await ctx.audit({
          action: `lacontract.progress_report.${input.decision}`,
          target: { type: 'LAProgressReport', id: input.reportId },
          ...(input.rationale ? { purpose: input.rationale } : {}),
          after: result,
        })
        return result
      }),

    generate: auditedProcedure
      .input(
        z.object({
          contractId: z.string(),
          familyId: z.string(),
          periodStart: z.coerce.date(),
          periodEnd: z.coerce.date(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertReportSignoff(user)
        // Wire the AI runner at the boundary so the core function stays I/O-free.
        const { runProgressReportDraft } = await import(
          '@studymind/ai/prompts/lacontract/progress-report'
        )
        const result = await generateProgressReportDraft(
          ctx.db,
          {
            contractId: input.contractId,
            learnerFamilyId: input.familyId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          },
          { actorId: user.id, requestId: ctx.requestId },
          (runnerInput) => runProgressReportDraft(runnerInput),
        )
        await ctx.audit({
          action: 'lacontract.progress_report_drafted',
          target: { type: 'LAProgressReport', id: result.reportId },
          after: { contractId: input.contractId, familyId: input.familyId },
        })
        return { reportId: result.reportId, promptVersion: result.promptVersion }
      }),
  }),

  invoice: router({
    generate: auditedProcedure
      .input(
        z.object({
          contractId: z.string(),
          familyId: z.string(),
          periodStart: z.coerce.date(),
          periodEnd: z.coerce.date(),
          ratePerHourMinor: z.number().int().nonnegative(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinance(user)
        const r = await generateLAInvoice(
          ctx.db,
          input,
          { actorId: user.id, requestId: ctx.requestId },
        )
        await ctx.audit({
          action: 'lacontract.invoice_generated',
          target: { type: 'LAInvoice', id: r.invoiceId },
          after: r,
        })
        return r
      }),

    markSent: auditedProcedure
      .input(
        z.object({
          invoiceId: z.string(),
          sentAt: z.coerce.date(),
          poNumber: z.string().min(1).max(200),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinance(user)
        await markLAInvoiceSent(ctx.db, input, {
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'lacontract.invoice_sent',
          target: { type: 'LAInvoice', id: input.invoiceId },
          after: { poNumber: input.poNumber },
        })
        return { ok: true }
      }),

    markPaid: auditedProcedure
      .input(
        z.object({
          invoiceId: z.string(),
          paidAt: z.coerce.date(),
          paymentReference: z.string().min(1).max(200),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinance(user)
        await markLAInvoicePaid(ctx.db, input, {
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'lacontract.invoice_paid',
          target: { type: 'LAInvoice', id: input.invoiceId },
          after: { paymentReference: input.paymentReference },
        })
        return { ok: true }
      }),
  }),
})
