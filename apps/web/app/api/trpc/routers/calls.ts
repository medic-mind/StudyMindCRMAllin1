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

function isVoicemailPayload(p: Record<string, unknown>): boolean {
  return (
    p['aircallEvent'] === 'call.voicemail_left' ||
    (typeof p['voicemailUrl'] === 'string' && (p['voicemailUrl'] as string).length > 0)
  )
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
        // after `to` still resolve a miss. Bounded; payload carries rawDigits.
        const rows = await ctx.db.interaction.findMany({
          where: { type: 'call', occurredAt: { gte: from, lte: now }, deletedAt: null },
          select: { id: true, occurredAt: true, contactId: true, payload: true },
          take: 20000,
        })

        const raws: RawCall[] = rows.map((r) => {
          const p = (r.payload ?? {}) as Record<string, unknown>
          const aircallCallId = typeof p['aircallCallId'] === 'number' ? (p['aircallCallId'] as number) : null
          const direction =
            p['direction'] === 'inbound' || p['direction'] === 'outbound' ? p['direction'] : null
          const durationSec = typeof p['durationSec'] === 'number' ? (p['durationSec'] as number) : 0
          const rawDigits = typeof p['rawDigits'] === 'string' ? (p['rawDigits'] as string) : null
          return {
            interactionId: r.id,
            aircallCallId,
            occurredAt: r.occurredAt,
            direction,
            durationSec,
            isVoicemail: isVoicemailPayload(p),
            rawDigits,
            contactId: r.contactId,
          }
        })

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

        return { items, counts, period: { from, to } }
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
  }),
})
