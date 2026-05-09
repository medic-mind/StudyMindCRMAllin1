// Tender router. CLAUDE.md §27, §43.1.
//
// Role-gated: ops_manager / admin can create and transition. DSL gets
// signoff on SEMH/EHCP-heavy drafts. read_only and finance see the board
// but cannot mutate.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  createTender,
  requestTenderDraft,
  signoffTenderDraft,
  TENDER_STATES,
  transitionTender,
  type TenderState,
} from '@studymind/core/tender'

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
  'read_only',
])
const WRITE_ROLES: ReadonlySet<SessionUser['role']> = new Set(['admin', 'ops_manager'])

function assertRead(user: SessionUser): void {
  if (!READ_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'cannot view tenders' })
  }
}

function assertWrite(user: SessionUser): void {
  if (!WRITE_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'ops_manager or admin required' })
  }
}

export const tenderRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    assertRead(requireUser(ctx))
    const tenders = await ctx.db.tender.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        laName: true,
        commissioner: true,
        state: true,
        accountLeadId: true,
        contractValueMinor: true,
        dueAt: true,
        isSemhOrEhcpHeavy: true,
        outcome: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return tenders
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      assertRead(requireUser(ctx))
      const t = await ctx.db.tender.findUnique({
        where: { id: input.id },
        include: {
          draftRequests: {
            select: {
              id: true,
              brief: true,
              draftText: true,
              promptVersion: true,
              signoffState: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      })
      if (!t) throw new TRPCError({ code: 'NOT_FOUND' })
      return t
    }),

  create: auditedProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(200),
        laName: z.string().trim().min(2).max(200),
        commissioner: z.string().trim().min(2).max(200).optional(),
        opportunityRef: z.string().trim().max(200).optional(),
        accountLeadId: z.string(),
        dueAt: z.coerce.date().optional(),
        contractValueMinor: z.number().int().nonnegative().optional(),
        isSemhOrEhcpHeavy: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user)
      const result = await createTender(
        ctx.db,
        {
          name: input.name,
          laName: input.laName,
          commissioner: input.commissioner ?? null,
          opportunityRef: input.opportunityRef ?? null,
          accountLeadId: input.accountLeadId,
          ...(input.dueAt ? { dueAt: input.dueAt } : {}),
          contractValueMinor: input.contractValueMinor ?? null,
          isSemhOrEhcpHeavy: input.isSemhOrEhcpHeavy,
        },
        { actorId: user.id, requestId: ctx.requestId },
      )
      await ctx.audit({
        action: 'tender.created',
        target: { type: 'Tender', id: result.tenderId },
        after: input,
      })
      return result
    }),

  transition: auditedProcedure
    .input(
      z.object({
        tenderId: z.string(),
        to: z.enum(TENDER_STATES),
        reason: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user)
      const r = await transitionTender(
        ctx.db,
        {
          tenderId: input.tenderId,
          to: input.to as TenderState,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        { actorId: user.id, requestId: ctx.requestId },
      )
      await ctx.audit({
        action: 'tender.state_changed',
        target: { type: 'Tender', id: input.tenderId },
        ...(input.reason ? { purpose: input.reason } : {}),
        after: r,
      })
      return r
    }),

  requestDraft: auditedProcedure
    .input(
      z.object({
        tenderId: z.string(),
        brief: z.string().min(20).max(8000),
        sectionsToDraft: z.array(z.string().min(1).max(120)).max(12).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user)
      const { runTenderDraft } = await import('@studymind/ai/prompts/tender/draft')
      const result = await requestTenderDraft(
        ctx.db,
        {
          tenderId: input.tenderId,
          brief: input.brief,
          sectionsToDraft: input.sectionsToDraft,
          requesterId: user.id,
        },
        { actorId: user.id, requestId: ctx.requestId },
        (runnerInput) => runTenderDraft(runnerInput),
      )
      await ctx.audit({
        action: 'tender.draft_requested',
        target: { type: 'TenderDraftRequest', id: result.draftId },
        after: { tenderId: input.tenderId },
      })
      return {
        draftId: result.draftId,
        promptVersion: result.promptVersion,
      }
    }),

  signoff: auditedProcedure
    .input(
      z.object({
        draftId: z.string(),
        role: z.enum(['account_lead', 'dsl']),
        decision: z.enum(['approve', 'request_changes', 'reject']),
        rationale: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // account_lead signoff requires ops_manager or admin; dsl requires
      // dsl or admin role.
      if (input.role === 'account_lead' && !WRITE_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'ops_manager or admin required' })
      }
      if (input.role === 'dsl' && user.role !== 'dsl' && user.role !== 'admin') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'DSL or admin required' })
      }
      const r = await signoffTenderDraft(
        ctx.db,
        {
          draftId: input.draftId,
          signerId: user.id,
          role: input.role,
          decision: input.decision,
          ...(input.rationale ? { rationale: input.rationale } : {}),
        },
        { actorId: user.id, requestId: ctx.requestId },
      )
      await ctx.audit({
        action: `tender.signoff.${input.decision}`,
        target: { type: 'TenderDraftRequest', id: input.draftId },
        ...(input.rationale ? { purpose: input.rationale } : {}),
        after: r,
      })
      return r
    }),
})
