// Missed-calls workspace (CLAUDE.md §10). A call queue an agent works to zero:
// every inbound call nobody answered (rang out OR voicemail), including unknown
// numbers, with whether it's been called back. "Called back" is *derived* — a
// later outbound call to the same number — so calling someone back from
// anywhere (the click-to-call here, the contact page, or Aircall itself)
// auto-resolves it, no manual step. A small manual override (actioned /
// dismissed) handles spam or "handled another way". Read: any staff. Write:
// Sales Executive+. Own small router to keep tRPC client-type inference cheap.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  deriveMissedCalls,
  isAnswered,
  normalizeCalls,
  projectCallInteraction,
  summariseMissedCalls,
  type MissedCallReviewRow,
  type RawCall,
} from '@studymind/core/calls'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const APPLY_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
])

function assertCanReview(role: UserRole): void {
  if (!APPLY_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Sales Executive or above can action missed calls',
    })
  }
}

function hasRecordingPayload(p: Record<string, unknown>): boolean {
  return (
    (typeof p['recordingS3Key'] === 'string' && (p['recordingS3Key'] as string).length > 0) ||
    (typeof p['recordingUrl'] === 'string' && (p['recordingUrl'] as string).length > 0) ||
    (typeof p['voicemailUrl'] === 'string' && (p['voicemailUrl'] as string).length > 0)
  )
}

type CallOutcome = 'answered' | 'missed' | 'voicemail'

function outcomeOf(c: { durationSec: number; isVoicemail: boolean }): CallOutcome {
  if (c.isVoicemail) return 'voicemail'
  if (isAnswered(c)) return 'answered'
  return 'missed'
}

export const callsRouter = router({
  missed: router({
    /**
     * Missed calls in the period with derived callback resolution. Outbound
     * calls right up to *now* drive resolution (so a callback after the period
     * end still resolves), while the displayed rows are bounded to [from, to].
     */
    list: protectedProcedure
      .input(
        z
          .object({
            from: z.coerce.date().optional(),
            to: z.coerce.date().optional(),
            filter: z.enum(['outstanding', 'called_back', 'all']).default('outstanding'),
            limit: z.number().int().min(1).max(500).default(200),
          })
          .default({ filter: 'outstanding', limit: 200 }),
      )
      .query(async ({ ctx, input }) => {
        requireUser(ctx)
        const now = new Date()
        const to = input.to ?? now
        const from = input.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

        // Load every call from `from` to now (both directions) so callbacks
        // after `to` still resolve a miss. Newest-first matters: the row cap
        // must shed the OLDEST rows, never recent callbacks — an unordered
        // findMany under the cap silently dropped an arbitrary subset, which
        // is exactly a "they were called back but it still says outstanding"
        // bug on busy windows.
        const rows = await ctx.db.interaction.findMany({
          where: { type: 'call', occurredAt: { gte: from, lte: now }, deletedAt: null },
          select: { id: true, occurredAt: true, contactId: true, payload: true },
          orderBy: { occurredAt: 'desc' },
          take: 20000,
        })

        const raws: RawCall[] = rows.map(projectCallInteraction)

        const calls = normalizeCalls(raws)

        // Manual overrides for the missed inbound calls in scope.
        const missedAircallIds = calls
          .filter((c) => c.direction === 'inbound' && !isAnswered(c) && c.aircallCallId)
          .map((c) => c.aircallCallId as string)
        const reviewRows = missedAircallIds.length
          ? await ctx.db.missedCallReview.findMany({
              where: { aircallCallId: { in: [...new Set(missedAircallIds)] } },
            })
          : []
        const reviewsByAircallId = new Map<string, MissedCallReviewRow>(
          reviewRows.map((r) => [
            r.aircallCallId,
            {
              status: r.status === 'dismissed' ? 'dismissed' : 'actioned',
              note: r.note,
              reviewedAt: r.reviewedAt,
              reviewedById: r.reviewedById,
            },
          ]),
        )

        const derived = deriveMissedCalls(calls, reviewsByAircallId)
        const inWindow = derived.filter((c) => c.occurredAt <= to)
        const counts = summariseMissedCalls(inWindow)

        // Sync health — so the workspace can explain WHY a callback isn't
        // clearing instead of silently showing stale state. "Called back" is
        // derived from outbound calls reaching the CRM (CLAUDE.md §10): if no
        // outbound call exists in the whole window while inbound calls do, the
        // outbound leg almost certainly isn't syncing (Aircall API creds unset
        // so the 10-min sync no-ops, or outbound webhooks not delivering).
        const outboundInWindow = calls.filter((c) => c.direction === 'outbound').length
        const inboundInWindow = calls.filter((c) => c.direction === 'inbound').length
        const apiConfigured = Boolean(
          process.env['AIRCALL_API_ID'] && process.env['AIRCALL_API_TOKEN'],
        )
        const lastSync = await ctx.db.cronRun.findFirst({
          where: { functionId: 'aircall/sync-calls' },
          orderBy: { finishedAt: 'desc' },
          select: { finishedAt: true, success: true },
        })
        const health = {
          apiConfigured,
          lastSyncAt: lastSync?.finishedAt ?? null,
          lastSyncSuccess: lastSync?.success ?? null,
          outboundInWindow,
          inboundInWindow,
        }

        let filtered = inWindow
        if (input.filter === 'outstanding') {
          filtered = inWindow.filter((c) => c.state === 'outstanding')
        } else if (input.filter === 'called_back') {
          filtered = inWindow.filter((c) => c.state === 'called_back')
        }
        const page = filtered.slice(0, input.limit)

        // Resolve contact display fields for the page.
        const contactIds = [...new Set(page.map((c) => c.contactId).filter((x): x is string => !!x))]
        const contacts = contactIds.length
          ? await ctx.db.contact.findMany({
              where: { id: { in: contactIds } },
              select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true, kind: true },
            })
          : []
        const contactMap = new Map(contacts.map((c) => [c.id, c]))

        const items = page.map((c) => {
          const contact = c.contactId ? contactMap.get(c.contactId) : null
          const name = contact
            ? [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
              contact.email ||
              null
            : null
          return {
            callKey: c.callKey,
            aircallCallId: c.aircallCallId,
            occurredAt: c.occurredAt,
            phone: c.rawDigits ?? contact?.phoneE164 ?? null,
            contactId: c.contactId,
            contactName: name,
            contactKind: contact?.kind ?? null,
            isVoicemail: c.isVoicemail,
            state: c.state,
            calledBackAt: c.calledBackAt,
            reviewStatus: c.review?.status ?? null,
            reviewNote: c.review?.note ?? null,
          }
        })

        return { items, counts, period: { from, to }, health }
      }),

    /** Manually mark a missed call actioned or dismissed (spam). Sales Exec+. */
    setReview: auditedProcedure
      .input(
        z.object({
          aircallCallId: z.string().min(1),
          status: z.enum(['actioned', 'dismissed']),
          note: z.string().trim().max(2000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanReview(user.role)
        await ctx.db.missedCallReview.upsert({
          where: { aircallCallId: input.aircallCallId },
          create: {
            aircallCallId: input.aircallCallId,
            status: input.status,
            note: input.note ?? null,
            reviewedById: user.id,
          },
          update: {
            status: input.status,
            note: input.note ?? null,
            reviewedById: user.id,
            reviewedAt: new Date(),
          },
        })
        await ctx.audit({
          action: input.status === 'dismissed' ? 'call.missed_dismissed' : 'call.missed_actioned',
          target: { type: 'AircallCall', id: input.aircallCallId },
          after: { status: input.status, note: input.note ?? null },
        })
        return { ok: true }
      }),

    /** Clear a manual override (back to derived state). Sales Exec+. */
    clearReview: auditedProcedure
      .input(z.object({ aircallCallId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanReview(user.role)
        await ctx.db.missedCallReview.deleteMany({ where: { aircallCallId: input.aircallCallId } })
        await ctx.audit({
          action: 'call.missed_review_cleared',
          target: { type: 'AircallCall', id: input.aircallCallId },
        })
        return { ok: true }
      }),

    /**
     * Force an immediate pull of recent calls from Aircall — for when a
     * specific missed call hasn't come through (a dropped webhook). Fires the
     * same sync job the 10-minute cron runs (re-pulls the last 24h, idempotent
     * on the Aircall call id). Sales Exec+; returns whether Aircall is
     * configured so the UI can explain a no-op.
     */
    syncNow: auditedProcedure.mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      assertCanReview(user.role)
      const configured = Boolean(
        process.env['AIRCALL_API_ID'] && process.env['AIRCALL_API_TOKEN'],
      )
      if (configured) {
        const { inngest } = await import('@studymind/jobs')
        await inngest.send({ name: 'aircall/sync-now.requested', data: {} })
      }
      await ctx.audit({
        action: 'call.sync_requested',
        target: { type: 'Integration', id: 'aircall' },
        after: { configured },
      })
      return { ok: true as const, configured }
    }),
  }),

  /** Full call history — every Aircall call (inbound + outbound, answered /
   *  missed / voicemail), newest first, with filters + recordings. Read: any
   *  staff. Per-call rows are deduped on the Aircall id (a call emits several
   *  events). */
  history: router({
    list: protectedProcedure
      .input(
        z
          .object({
            from: z.coerce.date().optional(),
            to: z.coerce.date().optional(),
            direction: z.enum(['all', 'inbound', 'outbound']).default('all'),
            outcome: z.enum(['all', 'answered', 'missed', 'voicemail']).default('all'),
            withRecording: z.boolean().default(false),
            page: z.number().int().min(1).default(1),
            pageSize: z.number().int().min(1).max(100).default(50),
          })
          .default({
            direction: 'all',
            outcome: 'all',
            withRecording: false,
            page: 1,
            pageSize: 50,
          }),
      )
      .query(async ({ ctx, input }) => {
        requireUser(ctx)
        const now = new Date()
        const to = input.to ?? now
        const from = input.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

        const rows = await ctx.db.interaction.findMany({
          where: { type: 'call', occurredAt: { gte: from, lte: to }, deletedAt: null },
          select: { id: true, occurredAt: true, contactId: true, payload: true },
          orderBy: { occurredAt: 'desc' },
          take: 20000,
        })

        // Per-call recording: pick the interaction id that actually carries the
        // audio, keyed the same way normalizeCalls collapses events.
        const recordingByKey = new Map<string, string>()
        const raws: RawCall[] = rows.map((r) => {
          const p = (r.payload ?? {}) as Record<string, unknown>
          const call = projectCallInteraction(r)
          const key = call.aircallCallId != null ? `ac:${call.aircallCallId}` : `iid:${r.id}`
          if (hasRecordingPayload(p) && !recordingByKey.has(key)) recordingByKey.set(key, r.id)
          return call
        })

        const normalized = normalizeCalls(raws)
          .map((c) => ({
            ...c,
            outcome: outcomeOf(c),
            recordingInteractionId: recordingByKey.get(c.callKey) ?? null,
          }))
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())

        const filtered = normalized.filter((c) => {
          if (input.direction !== 'all' && c.direction !== input.direction) return false
          if (input.outcome !== 'all' && c.outcome !== input.outcome) return false
          if (input.withRecording && !c.recordingInteractionId) return false
          return true
        })

        const counts = {
          total: filtered.length,
          inbound: filtered.filter((c) => c.direction === 'inbound').length,
          outbound: filtered.filter((c) => c.direction === 'outbound').length,
          answered: filtered.filter((c) => c.outcome === 'answered').length,
          missed: filtered.filter((c) => c.outcome === 'missed').length,
          voicemail: filtered.filter((c) => c.outcome === 'voicemail').length,
        }

        const start = (input.page - 1) * input.pageSize
        const pageRows = filtered.slice(start, start + input.pageSize)

        const contactIds = [
          ...new Set(pageRows.map((c) => c.contactId).filter((x): x is string => !!x)),
        ]
        const contacts = contactIds.length
          ? await ctx.db.contact.findMany({
              where: { id: { in: contactIds } },
              select: { id: true, firstName: true, lastName: true, email: true, kind: true },
            })
          : []
        const contactMap = new Map(contacts.map((c) => [c.id, c]))

        const items = pageRows.map((c) => {
          const contact = c.contactId ? contactMap.get(c.contactId) : null
          const name = contact
            ? [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
              contact.email ||
              null
            : null
          return {
            callKey: c.callKey,
            occurredAt: c.occurredAt,
            direction: c.direction,
            durationSec: c.durationSec,
            outcome: c.outcome,
            phone: c.rawDigits,
            contactId: c.contactId,
            contactName: name,
            contactKind: contact?.kind ?? null,
            recordingInteractionId: c.recordingInteractionId,
          }
        })

        return {
          items,
          counts,
          page: input.page,
          pageSize: input.pageSize,
          total: counts.total,
          period: { from, to },
          capped: rows.length >= 20000,
        }
      }),
  }),
})
