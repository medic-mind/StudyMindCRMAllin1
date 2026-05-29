// Reports router. Read-only summaries for the Reports surface.
// CLAUDE.md §27. Role-gated: ceo | senior_manager | manager (ADR 0014).

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const REPORT_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

function assertReports(user: SessionUser): void {
  if (!REPORT_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN' })
  }
}

const PeriodInput = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
})

/**
 * Buckets the period [from, to] into ISO weeks (Mon-Sun). Returns the start
 * of each week as a Date in ascending order. Used to build the x-axis for
 * the chart endpoints.
 */
function isoWeekStarts(from: Date, to: Date): Date[] {
  const starts: Date[] = []
  const cursor = new Date(from)
  // Snap to Monday 00:00 UTC.
  cursor.setUTCHours(0, 0, 0, 0)
  const day = cursor.getUTCDay() // 0=Sun..6=Sat
  const offset = day === 0 ? -6 : 1 - day
  cursor.setUTCDate(cursor.getUTCDate() + offset)
  while (cursor <= to) {
    starts.push(new Date(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 7)
  }
  return starts
}

function weekIndex(d: Date, weekStarts: Date[]): number {
  for (let i = weekStarts.length - 1; i >= 0; i--) {
    const ws = weekStarts[i]
    if (ws && d >= ws) return i
  }
  return 0
}

function weekLabel(d: Date): string {
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${m}/${day}`
}

export const reportsRouter = router({
  finance: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        const [openDiscrepancies, payments] = await Promise.all([
          ctx.db.reconciliationDiscrepancy.groupBy({
            by: ['category'],
            where: { resolvedAt: null },
            _count: { id: true },
          }),
          ctx.db.payment.findMany({
            where: {
              receivedAt: { gte: input.from, lte: input.to },
              deletedAt: null,
            },
            select: {
              amountMinor: true,
              provider: true,
              reverted: true,
            },
          }),
        ])

        const moneyInMinor = payments
          .filter((p) => !p.reverted)
          .reduce((acc, p) => acc + p.amountMinor, 0)
        const revertedMinor = payments
          .filter((p) => p.reverted)
          .reduce((acc, p) => acc + p.amountMinor, 0)

        const byProvider: Record<string, number> = {}
        for (const p of payments) {
          if (p.reverted) continue
          byProvider[p.provider] = (byProvider[p.provider] ?? 0) + p.amountMinor
        }

        // Reconciliation lag percentile — time between Payment.receivedAt and
        // its first Allocation (when no allocation yet, treat as ongoing and
        // exclude). Cheap to compute on the read side; for production scale
        // this would be precomputed nightly.
        const recent = await ctx.db.payment.findMany({
          where: {
            receivedAt: { gte: input.from, lte: input.to },
            deletedAt: null,
          },
          select: {
            receivedAt: true,
            allocations: {
              select: { createdAt: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
          take: 500,
        })
        const lagsSec = recent
          .map((p) => {
            const alloc = p.allocations[0]
            if (!alloc) return null
            return Math.max(0, (alloc.createdAt.getTime() - p.receivedAt.getTime()) / 1000)
          })
          .filter((x): x is number => x !== null)
          .sort((a, b) => a - b)
        const p50 = lagsSec[Math.floor(lagsSec.length * 0.5)] ?? null
        const p90 = lagsSec[Math.floor(lagsSec.length * 0.9)] ?? null

        // Weekly timeseries: money in / reverted / unallocated by week.
        // We bucket the *same* payments[] used above; reconciliation only
        // counts a payment as allocated once it has at least one
        // Allocation row, so we mirror that here.
        const weekStarts = isoWeekStarts(input.from, input.to)
        const moneyInByWeek = new Array(weekStarts.length).fill(0) as number[]
        const revertedByWeek = new Array(weekStarts.length).fill(0) as number[]
        const unallocatedByWeek = new Array(weekStarts.length).fill(0) as number[]
        const paymentsWithAlloc = await ctx.db.payment.findMany({
          where: {
            receivedAt: { gte: input.from, lte: input.to },
            deletedAt: null,
          },
          select: {
            amountMinor: true,
            receivedAt: true,
            reverted: true,
            allocations: { select: { id: true }, take: 1 },
          },
          take: 5000,
        })
        for (const p of paymentsWithAlloc) {
          const i = weekIndex(p.receivedAt, weekStarts)
          if (p.reverted) {
            revertedByWeek[i] = (revertedByWeek[i] ?? 0) + p.amountMinor
            continue
          }
          if (p.allocations.length === 0) {
            unallocatedByWeek[i] = (unallocatedByWeek[i] ?? 0) + p.amountMinor
          } else {
            moneyInByWeek[i] = (moneyInByWeek[i] ?? 0) + p.amountMinor
          }
        }
        const weekLabels = weekStarts.map(weekLabel)

        return {
          period: { from: input.from, to: input.to },
          openDiscrepancies: openDiscrepancies.map((d) => ({
            category: d.category as string,
            count: d._count.id,
          })),
          moneyInMinor,
          revertedMinor,
          byProviderMinor: byProvider,
          reconciliationLag: {
            p50Sec: p50,
            p90Sec: p90,
            sampleSize: lagsSec.length,
          },
          weekly: {
            labels: weekLabels,
            moneyInMinor: moneyInByWeek,
            revertedMinor: revertedByWeek,
            unallocatedMinor: unallocatedByWeek,
          },
        }
      }),
  }),

  operations: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        const sessions = await ctx.db.bookingSession.findMany({
          where: {
            scheduledAt: { gte: input.from, lte: input.to },
            deletedAt: null,
          },
          select: {
            state: true,
            scheduledHours: true,
            deliveredHours: true,
            scheduledAt: true,
          },
          take: 5000,
        })

        const weekStarts = isoWeekStarts(input.from, input.to)
        const deliveredHoursByWeek = new Array(weekStarts.length).fill(0) as number[]
        const deliveredSessionsByWeek = new Array(weekStarts.length).fill(0) as number[]
        for (const s of sessions) {
          if (s.state !== 'delivered') continue
          const i = weekIndex(s.scheduledAt, weekStarts)
          deliveredHoursByWeek[i] = (deliveredHoursByWeek[i] ?? 0) + s.deliveredHours
          deliveredSessionsByWeek[i] = (deliveredSessionsByWeek[i] ?? 0) + 1
        }

        const totals = {
          scheduled: 0,
          delivered: 0,
          noShow: 0,
          cancelled: 0,
          confirmed: 0,
          tentative: 0,
        }
        let scheduledHours = 0
        let deliveredHours = 0
        for (const s of sessions) {
          scheduledHours += s.scheduledHours
          deliveredHours += s.deliveredHours
          switch (s.state) {
            case 'delivered':
              totals.delivered += 1
              break
            case 'no_show':
              totals.noShow += 1
              break
            case 'cancelled':
              totals.cancelled += 1
              break
            case 'confirmed':
              totals.confirmed += 1
              break
            case 'tentative':
              totals.tentative += 1
              break
          }
          totals.scheduled += 1
        }

        const missedRate =
          totals.scheduled === 0
            ? 0
            : (totals.noShow + totals.cancelled) / totals.scheduled

        return {
          period: { from: input.from, to: input.to },
          sessionsByState: totals,
          scheduledHours,
          deliveredHours,
          missedSessionRate: missedRate,
          weekly: {
            labels: weekStarts.map(weekLabel),
            deliveredHours: deliveredHoursByWeek,
            deliveredSessions: deliveredSessionsByWeek,
          },
        }
      }),
  }),

  retention: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        const [families, churnScores, churnedThisPeriod] = await Promise.all([
          ctx.db.family.groupBy({
            by: ['state'],
            where: { deletedAt: null },
            _count: { id: true },
          }),
          ctx.db.churnScore.findMany({
            where: {
              scoredAt: { gte: input.from, lte: input.to },
            },
            orderBy: { scoredAt: 'desc' },
            select: { score: true, familyId: true, scoredAt: true },
            take: 1000,
          }),
          ctx.db.interaction.count({
            where: {
              type: 'family_state_changed',
              occurredAt: { gte: input.from, lte: input.to },
            },
          }),
        ])

        // Bucket churn scores into deciles for a simple histogram.
        const buckets = new Array(10).fill(0) as number[]
        for (const s of churnScores) {
          const idx = Math.min(9, Math.max(0, Math.floor(s.score * 10)))
          buckets[idx] = (buckets[idx] ?? 0) + 1
        }

        return {
          period: { from: input.from, to: input.to },
          familiesByState: families.map((f) => ({
            state: f.state as string,
            count: f._count.id,
          })),
          churnScoreHistogram: buckets,
          churnScoreSamples: churnScores.length,
          churnEventsInPeriod: churnedThisPeriod,
        }
      }),
  }),

  // Aircall analytics. Counts unique calls (deduped on aircallCallId),
  // classifies answered vs voicemail vs missed, builds a peak-time matrix,
  // and surfaces top contacts by call volume. CLAUDE.md §10.
  aircall: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        const rows = await ctx.db.interaction.findMany({
          where: {
            type: 'call',
            occurredAt: { gte: input.from, lte: input.to },
            deletedAt: null,
          },
          select: {
            occurredAt: true,
            contactId: true,
            payload: true,
          },
          take: 50_000,
        })

        // Multiple webhook events per call (created/answered/ended/etc). Keep
        // the row with the longest duration (typically the call.ended row).
        interface NormalisedCall {
          callId: string
          contactId: string | null
          occurredAt: Date
          direction: 'inbound' | 'outbound' | null
          durationSec: number
          isVoicemail: boolean
        }
        const byCall = new Map<string, NormalisedCall>()
        for (const r of rows) {
          const p = (r.payload ?? {}) as Record<string, unknown>
          const callId =
            typeof p['aircallCallId'] === 'string'
              ? (p['aircallCallId'] as string)
              : `unknown:${r.occurredAt.toISOString()}`
          const directionRaw = p['direction']
          const direction =
            directionRaw === 'inbound' || directionRaw === 'outbound'
              ? directionRaw
              : null
          const durationSec =
            typeof p['durationSec'] === 'number' ? (p['durationSec'] as number) : 0
          const event = p['aircallEvent']
          const isVoicemail =
            event === 'call.voicemail_left' ||
            (typeof p['voicemailUrl'] === 'string' && p['voicemailUrl'].length > 0)

          const prev = byCall.get(callId)
          if (!prev) {
            byCall.set(callId, {
              callId,
              contactId: r.contactId,
              occurredAt: r.occurredAt,
              direction,
              durationSec,
              isVoicemail,
            })
          } else {
            if (durationSec > prev.durationSec) prev.durationSec = durationSec
            if (prev.direction == null && direction != null) prev.direction = direction
            if (isVoicemail) prev.isVoicemail = true
            // Earliest occurredAt as the canonical call start.
            if (r.occurredAt < prev.occurredAt) prev.occurredAt = r.occurredAt
          }
        }

        const calls = [...byCall.values()]
        const total = calls.length
        const inbound = calls.filter((c) => c.direction === 'inbound').length
        const outbound = calls.filter((c) => c.direction === 'outbound').length
        const voicemails = calls.filter((c) => c.isVoicemail).length
        const missed = calls.filter((c) => !c.isVoicemail && c.durationSec === 0).length
        const answered = total - voicemails - missed
        const answeredCalls = calls.filter((c) => !c.isVoicemail && c.durationSec > 0)
        const avgDurationSec =
          answeredCalls.length === 0
            ? 0
            : Math.round(
                answeredCalls.reduce((s, c) => s + c.durationSec, 0) / answeredCalls.length,
              )
        const totalTalkSec = calls.reduce((s, c) => s + c.durationSec, 0)

        // Daily series.
        function isoDay(d: Date): string {
          const y = d.getUTCFullYear()
          const m = String(d.getUTCMonth() + 1).padStart(2, '0')
          const day = String(d.getUTCDate()).padStart(2, '0')
          return `${y}-${m}-${day}`
        }
        const days: string[] = []
        const cursor = new Date(input.from)
        cursor.setUTCHours(0, 0, 0, 0)
        while (cursor <= input.to) {
          days.push(isoDay(cursor))
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        }
        const dailyCounts = new Map<string, number>(days.map((d) => [d, 0]))
        for (const c of calls) {
          const key = isoDay(c.occurredAt)
          if (dailyCounts.has(key)) {
            dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + 1)
          }
        }

        // Peak time matrix [dow Mon=0..Sun=6][hour 0..23] in the user's
        // displayed timezone — we treat occurredAt as UTC; the front-end
        // displays it under the assumption that calls cluster on UK business
        // hours. CLAUDE.md §29.
        const peak: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0))
        for (const c of calls) {
          const d = new Date(c.occurredAt)
          // Convert Sun=0..Sat=6 → Mon=0..Sun=6 for UK-friendly ordering.
          const jsDow = d.getUTCDay()
          const dow = (jsDow + 6) % 7
          const hour = d.getUTCHours()
          ;(peak[dow] as number[])[hour] = ((peak[dow] as number[])[hour] ?? 0) + 1
        }

        // Top contacts.
        const byContact = new Map<string, number>()
        for (const c of calls) {
          if (!c.contactId) continue
          byContact.set(c.contactId, (byContact.get(c.contactId) ?? 0) + 1)
        }
        const ranked = [...byContact.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        const ids = ranked.map(([id]) => id)
        const contacts =
          ids.length > 0
            ? await ctx.db.contact.findMany({
                where: { id: { in: ids } },
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phoneE164: true,
                  kind: true,
                },
              })
            : []
        const contactMap = new Map(contacts.map((c) => [c.id, c]))
        const topContacts = ranked.map(([id, count]) => {
          const c = contactMap.get(id)
          const name =
            c && (c.firstName || c.lastName)
              ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()
              : c?.email ?? c?.phoneE164 ?? id.slice(0, 8)
          return {
            id,
            name,
            kind: c?.kind ?? null,
            phoneE164: c?.phoneE164 ?? null,
            count,
          }
        })

        return {
          period: { from: input.from, to: input.to },
          kpis: {
            total,
            answered,
            voicemails,
            missed,
            inbound,
            outbound,
            avgDurationSec,
            totalTalkSec,
            answeredRate: total === 0 ? 0 : answered / total,
          },
          daily: {
            labels: days,
            counts: days.map((d) => dailyCounts.get(d) ?? 0),
          },
          peak,
          topContacts,
        }
      }),
  }),
})
