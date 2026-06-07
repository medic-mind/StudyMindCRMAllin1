// Admin → Backfill control surface (ADR 0017).
//
//   - list / get: read recent BackfillJob rows (CEO | Senior Manager |
//     Manager).
//   - start:      trigger a 90-day backfill for a shared-token provider
//     (Aircall, Slack). Per-agent providers (Gmail, Trengo) auto-trigger on
//     connect, so `start` here is for the providers without a connect
//     surface. CEO | Senior Manager only.
//   - cancel:     mark a pending/running job cancelled. CEO | Senior Manager.
//
// CLAUDE.md §17, §20.1.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  BackfillAlreadyRunningError,
  markBackfillCancelled,
  STALE_BACKFILL_MS,
  startBackfill,
} from '@studymind/core/backfill'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const READ_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

const WRITE_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
])

const ProviderEnum = z.enum(['gmail', 'aircall', 'trengo', 'slack'])

export const adminBackfillRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        provider: ProviderEnum.optional(),
        limit: z.number().min(1).max(100).default(25),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!READ_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const rows = await ctx.db.backfillJob.findMany({
        where: input.provider ? { provider: input.provider } : {},
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        select: {
          id: true,
          provider: true,
          agentId: true,
          status: true,
          windowFrom: true,
          windowTo: true,
          totalCount: true,
          processedCount: true,
          matchedCount: true,
          skippedCount: true,
          error: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
        },
      })
      return rows
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!READ_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const row = await ctx.db.backfillJob.findUnique({ where: { id: input.id } })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return row
    }),

  /** Trigger a backfill for a shared-token provider (Aircall, Slack). */
  start: auditedProcedure
    .input(z.object({ provider: z.enum(['aircall', 'slack']) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!WRITE_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const { inngest } = await import('@studymind/jobs')
      try {
        const res = await startBackfill(ctx.db, inngest, {
          provider: input.provider,
          agentId: null,
          // Aircall: a clean 1-month historic import (CLAUDE.md §10); the
          // recurring aircall/sync-calls cron keeps it current from there.
          // Slack stays on the standard 90-day window (ADR 0017).
          windowDays: input.provider === 'aircall' ? 30 : 90,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        // startBackfill already wrote the backfill.started audit row; record
        // the admin-initiated trigger too so the operator action is captured.
        await ctx.audit({
          action: 'backfill.started',
          target: { type: 'BackfillJob', id: res.jobId },
          after: { provider: input.provider, initiatedBy: user.id },
        })
        return { jobId: res.jobId }
      } catch (err) {
        if (err instanceof BackfillAlreadyRunningError) {
          // Audit the no-op so auditedProcedure's runtime check is satisfied.
          await ctx.audit({
            action: 'backfill.started',
            target: { type: 'BackfillJob', id: err.existingJobId },
            after: { provider: input.provider, alreadyRunning: true },
          })
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A backfill for this provider is already pending or running.',
          })
        }
        throw err
      }
    }),

  /**
   * Manual Trengo history import for the calling agent. Unlike the 90-day
   * auto-on-connect backfill, this defaults to an ~8-month window and CREATES
   * a Contact for senders not already in the CRM (the explicit, operator-
   * confirmed exception to §11's webhook default). It runs through the
   * caller's own per-agent Trengo token, so they must have connected one.
   * CEO | Senior Manager only.
   */
  trengoImport: auditedProcedure
    .input(
      z.object({
        windowDays: z.number().int().min(1).max(366).default(243),
        createContacts: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!WRITE_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })

      const token = await ctx.db.trengoToken.findFirst({
        where: { agentId: user.id, deletedAt: null },
        select: { agentId: true },
      })
      if (!token) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Connect your Trengo token first (Account → Trengo), then start the import.',
        })
      }

      const { inngest } = await import('@studymind/jobs')
      try {
        const res = await startBackfill(ctx.db, inngest, {
          provider: 'trengo',
          agentId: user.id,
          windowDays: input.windowDays,
          createContacts: input.createContacts,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        await ctx.audit({
          action: 'backfill.started',
          target: { type: 'BackfillJob', id: res.jobId },
          after: {
            provider: 'trengo',
            windowDays: input.windowDays,
            createContacts: input.createContacts,
            initiatedBy: user.id,
          },
        })
        return { jobId: res.jobId }
      } catch (err) {
        if (err instanceof BackfillAlreadyRunningError) {
          await ctx.audit({
            action: 'backfill.started',
            target: { type: 'BackfillJob', id: err.existingJobId },
            after: { provider: 'trengo', alreadyRunning: true },
          })
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A Trengo backfill is already pending or running.',
          })
        }
        throw err
      }
    }),

  cancel: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!WRITE_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const row = await ctx.db.backfillJob.findUnique({
        where: { id: input.id },
        select: { status: true },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      if (row.status !== 'pending' && row.status !== 'running') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Only pending or running backfills can be cancelled.',
        })
      }
      await markBackfillCancelled(ctx.db, input.id, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      // markBackfillCancelled writes its own audit row; we still call
      // ctx.audit so the auditedProcedure runtime check is satisfied and the
      // operator action is attributed to this request.
      await ctx.audit({
        action: 'backfill.cancelled',
        target: { type: 'BackfillJob', id: input.id },
        after: { cancelledBy: user.id },
      })
      return { ok: true as const }
    }),

  // ADR 0020 Phase 2c — one-shot Conversation-head backfill. Distinct from
  // the provider backfills above: this re-derives the queryable conversation
  // state from rows we already have in Interaction, rather than pulling new
  // history from a provider. CEO + Senior Manager only. Fires the
  // self-recursive Inngest function (concurrency 1 — the function id is the
  // advisory lock, so a duplicate trigger is harmless but warned about).
  conversationHeads: router({
    start: auditedProcedure.mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!WRITE_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const { inngest } = await import('@studymind/jobs')
      const jobId = `chbf_${Date.now().toString(36)}_${user.id.slice(-6)}`
      await inngest.send({
        name: 'migration/backfill-conversation-heads.requested',
        data: { jobId },
      })
      await ctx.audit({
        action: 'migration.conversation_head_backfill_requested',
        target: { type: 'System', id: jobId },
        after: { initiatedBy: user.id },
      })
      return { jobId }
    }),
  }),

  /** Running jobs for the current user — drives the progress banner. */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    const rows = await ctx.db.backfillJob.findMany({
      where: {
        status: 'running',
        // Only surface genuinely-live jobs. A worker that dies mid-run leaves
        // the row `running` forever; a healthy run advances `updatedAt` on
        // every progress write, so this window hides abandoned jobs that
        // otherwise showed a permanent "Importing 0 items…" banner. The
        // backfill/reap-stale cron then fails them for good. CLAUDE.md §17.
        updatedAt: { gte: new Date(Date.now() - STALE_BACKFILL_MS) },
        OR: [{ agentId: user.id }, { agentId: null }],
      },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        provider: true,
        totalCount: true,
        processedCount: true,
        matchedCount: true,
      },
    })
    return rows
  }),
})
