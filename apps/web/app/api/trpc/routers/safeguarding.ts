// Safeguarding router. CLAUDE.md §27, §42.
// All mutations are role-gated and audited via the auditedProcedure runtime check.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  raiseConcern,
  recordLaReferral,
  triageAction,
  type SourceType,
  type TriageAction,
  type Urgency,
} from '@studymind/core/safeguarding'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

const RaiseInput = z.object({
  contactId: z.string(),
  sourceType: z.enum(['call', 'message', 'email', 'third_party', 'note']),
  sourceId: z.string().nullable().default(null),
  urgency: z.enum(['routine', 'urgent', 'immediate']),
  body: z.string().min(1).max(8000),
  isInPlacement: z.boolean().default(false),
})

const TriageInput = z.object({
  flagId: z.string(),
  action: z.enum([
    'acknowledge',
    'request_info',
    'escalate_restricted',
    'refer_la',
    'refer_mash',
    'close_resolved',
  ]),
  rationale: z.string().min(1).max(2000),
})

const LaReferralInput = z.object({
  flagId: z.string(),
  la: z.string().min(1).max(200),
  caseworker: z.string().min(1).max(200),
  referenceNumber: z.string().min(1).max(200),
  channel: z.enum(['email', 'phone', 'portal', 'post']),
})

function assertCanFlag(role: string): void {
  if (!['admin', 'ops_manager', 'agent', 'dsl'].includes(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Role cannot raise concerns.' })
  }
}

function assertCanTriage(role: string): asserts role is 'admin' | 'dsl' {
  if (role !== 'admin' && role !== 'dsl') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only DSL or admin may triage.' })
  }
}

export const safeguardingRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!['admin', 'dsl', 'ops_manager'].includes(user.role)) {
      throw new TRPCError({ code: 'FORBIDDEN' })
    }
    const flags = await ctx.db.safeguardingFlag.findMany({
      where: { deletedAt: null, state: { in: ['concern_logged', 'restricted_access'] } },
      include: {
        contact: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ urgency: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    })
    return flags.map((f) => ({
      id: f.id,
      contactId: f.contactId,
      contactName: [f.contact.firstName, f.contact.lastName].filter(Boolean).join(' '),
      state: f.state,
      urgency: f.urgency,
      dslUserId: f.dslUserId,
      createdAt: f.createdAt,
    }))
  }),

  raise: auditedProcedure.input(RaiseInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanFlag(user.role)
    const result = await raiseConcern(
      ctx.db,
      {
        contactId: input.contactId,
        raisedBy: user.id,
        sourceType: input.sourceType as SourceType,
        sourceId: input.sourceId,
        urgency: input.urgency as Urgency,
        body: input.body,
        isInPlacement: input.isInPlacement,
      },
      { actorId: user.id, requestId: ctx.requestId },
    )
    // raiseConcern writes its own audit row; record one more so the
    // auditedProcedure runtime check passes.
    await ctx.audit({
      action: 'safeguarding.flag',
      target: { type: 'SafeguardingFlag', id: result.flagId },
      after: { contactId: input.contactId, urgency: input.urgency },
    })
    return result
  }),

  triage: auditedProcedure.input(TriageInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanTriage(user.role)
    await triageAction(
      ctx.db,
      input as { flagId: string; action: TriageAction; rationale: string },
      { actorId: user.id, requestId: ctx.requestId, role: user.role },
    )
    await ctx.audit({
      action: `safeguarding.triage.${input.action}`,
      target: { type: 'SafeguardingFlag', id: input.flagId },
      purpose: input.rationale,
    })
    return { ok: true }
  }),

  recordLaReferral: auditedProcedure
    .input(LaReferralInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanTriage(user.role)
      await recordLaReferral(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      await ctx.audit({
        action: 'safeguarding.la_referral',
        target: { type: 'SafeguardingFlag', id: input.flagId },
        after: { la: input.la, referenceNumber: input.referenceNumber },
      })
      return { ok: true }
    }),
})
