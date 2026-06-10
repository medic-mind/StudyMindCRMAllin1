// Reports router. Read-only summaries for the Reports surface.
// CLAUDE.md §27. Role-gated: ceo | senior_manager | manager (ADR 0014).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  classifyStoredCall,
  describePeakWindow,
  instantMatchesWindow,
  isPeakInstant,
  PeakWindowInput,
  PeakWindowUpdateInput,
  type PeakInstant,
  type PeakWindowDef,
} from '@studymind/core/reports'

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

// Peak times are a UK-team concern, so we classify calls on the Europe/London
// clock rather than the server's UTC — otherwise an evening peak window drifts
// by an hour during British Summer Time.
const LONDON_PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  hour12: false,
})
const DOW_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}
/** Calendar parts of a UTC instant on the Europe/London clock. */
function londonParts(d: Date): PeakInstant {
  const parts = LONDON_PARTS_FMT.formatToParts(d)
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  let hour = Number.parseInt(pick('hour'), 10)
  if (!Number.isFinite(hour) || hour === 24) hour = 0
  return {
    year: Number.parseInt(pick('year'), 10),
    month: Number.parseInt(pick('month'), 10),
    day: Number.parseInt(pick('day'), 10),
    dow: DOW_INDEX[pick('weekday')] ?? 0,
    hour,
  }
}

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

/**
 * Inclusive end of the `to` day. The report period presets pass the to-date at
 * 00:00 UTC, so a raw `lte: to` silently drops everything that happened on that
 * date itself — most visibly today's data, and it makes counts jump between the
 * default view (which uses `now`) and a clicked preset. Snap to end-of-day UTC.
 */
function endOfUtcDay(d: Date): Date {
  const out = new Date(d)
  out.setUTCHours(23, 59, 59, 999)
  return out
}

export const reportsRouter = router({
  finance: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))
        const periodTo = endOfUtcDay(input.to)

        const [openDiscrepancies, payments] = await Promise.all([
          ctx.db.reconciliationDiscrepancy.groupBy({
            by: ['category'],
            where: { resolvedAt: null },
            _count: { id: true },
          }),
          ctx.db.payment.findMany({
            where: {
              receivedAt: { gte: input.from, lte: periodTo },
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
            receivedAt: { gte: input.from, lte: periodTo },
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
        const weekStarts = isoWeekStarts(input.from, periodTo)
        const moneyInByWeek = new Array(weekStarts.length).fill(0) as number[]
        const revertedByWeek = new Array(weekStarts.length).fill(0) as number[]
        const unallocatedByWeek = new Array(weekStarts.length).fill(0) as number[]
        const paymentsWithAlloc = await ctx.db.payment.findMany({
          where: {
            receivedAt: { gte: input.from, lte: periodTo },
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
        const periodTo = endOfUtcDay(input.to)

        const sessions = await ctx.db.bookingSession.findMany({
          where: {
            scheduledAt: { gte: input.from, lte: periodTo },
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

        const weekStarts = isoWeekStarts(input.from, periodTo)
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
        const periodTo = endOfUtcDay(input.to)

        const [families, churnScores, churnedThisPeriod] = await Promise.all([
          ctx.db.family.groupBy({
            by: ['state'],
            where: { deletedAt: null },
            _count: { id: true },
          }),
          ctx.db.churnScore.findMany({
            where: {
              scoredAt: { gte: input.from, lte: periodTo },
            },
            orderBy: { scoredAt: 'desc' },
            select: { score: true, familyId: true, scoredAt: true },
            take: 1000,
          }),
          ctx.db.interaction.count({
            where: {
              type: 'family_state_changed',
              occurredAt: { gte: input.from, lte: periodTo },
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
  // hourly throughput, duration histogram, period-over-period deltas, and
  // surfaces top contacts + the recent missed/voicemail trays. CLAUDE.md §10.
  aircall: router({
    summary: protectedProcedure
      .input(
        PeriodInput.extend({
          direction: z.enum(['all', 'inbound', 'outbound']).default('all'),
          /** Provider filter: all | aircall | google_voice | manual. */
          provider: z
            .enum(['all', 'aircall', 'google_voice', 'manual'])
            .default('all'),
        }),
      )
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        // Include the whole of the `to` day (endOfUtcDay) for every window
        // below, otherwise today's calls drop out and counts jump vs default.
        const periodTo = endOfUtcDay(input.to)

        interface NormalisedCall {
          callId: string
          contactId: string | null
          occurredAt: Date
          direction: 'inbound' | 'outbound' | null
          durationSec: number
          isVoicemail: boolean
          provider: 'aircall' | 'google_voice' | 'manual'
          /** Counterparty E.164, used as the tray label when no Contact. */
          rawDigits: string | null
        }

        async function loadCalls(from: Date, to: Date): Promise<NormalisedCall[]> {
          const rows = await ctx.db.interaction.findMany({
            where: {
              type: 'call',
              occurredAt: { gte: from, lte: to },
              deletedAt: null,
            },
            select: { occurredAt: true, contactId: true, payload: true },
            take: 50_000,
          })
          const byCall = new Map<string, NormalisedCall>()
          for (const r of rows) {
            const p = (r.payload ?? {}) as Record<string, unknown>
            // Stable provider + dedupe key. Aircall ids are numeric, so this
            // collapses the several lifecycle-event rows (and the backfill/sync
            // row) for one call into a single call — otherwise one call is
            // counted many times and its duration-0 events distort missed vs
            // answered. CLAUDE.md §10.
            const { provider, callId } = classifyStoredCall(p, r.occurredAt)
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
            const rawDigits =
              typeof p['rawDigits'] === 'string' && p['rawDigits'].length > 0
                ? (p['rawDigits'] as string)
                : null
            const prev = byCall.get(callId)
            if (!prev) {
              byCall.set(callId, {
                callId,
                contactId: r.contactId,
                occurredAt: r.occurredAt,
                direction,
                durationSec,
                isVoicemail,
                provider,
                rawDigits,
              })
            } else {
              if (durationSec > prev.durationSec) prev.durationSec = durationSec
              if (prev.direction == null && direction != null) prev.direction = direction
              if (isVoicemail) prev.isVoicemail = true
              if (!prev.rawDigits && rawDigits) prev.rawDigits = rawDigits
              if (r.occurredAt < prev.occurredAt) prev.occurredAt = r.occurredAt
            }
          }
          return [...byCall.values()].filter((c) => {
            if (input.direction === 'inbound' && c.direction !== 'inbound') return false
            if (input.direction === 'outbound' && c.direction !== 'outbound') return false
            if (input.provider !== 'all' && c.provider !== input.provider) return false
            return true
          })
        }

        interface Aggregate {
          total: number
          answered: number
          voicemails: number
          missed: number
          inbound: number
          outbound: number
          avgDurationSec: number
          totalTalkSec: number
          answeredRate: number
        }

        function aggregate(calls: NormalisedCall[]): Aggregate {
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
          return {
            total,
            answered,
            voicemails,
            missed,
            inbound,
            outbound,
            avgDurationSec,
            totalTalkSec,
            answeredRate: total === 0 ? 0 : answered / total,
          }
        }

        // Period-over-period: same-length window immediately before. The
        // previous window exists only for the deltas, so fetch BOTH windows in
        // one round-trip (prevFrom..periodTo) and split in memory — half the
        // DB latency of the old two-query version on every filter change.
        const periodMs = periodTo.getTime() - input.from.getTime()
        const prevFrom = new Date(input.from.getTime() - periodMs)
        const prevTo = new Date(input.from.getTime() - 1)

        const combined = await loadCalls(prevFrom, periodTo)
        const calls = combined.filter((c) => c.occurredAt >= input.from)
        const prevCalls = combined.filter((c) => c.occurredAt < input.from)
        const kpis = aggregate(calls)
        const prevKpis = aggregate(prevCalls)

        // Daily series + inbound/outbound split.
        function isoDay(d: Date): string {
          const y = d.getUTCFullYear()
          const m = String(d.getUTCMonth() + 1).padStart(2, '0')
          const day = String(d.getUTCDate()).padStart(2, '0')
          return `${y}-${m}-${day}`
        }
        const days: string[] = []
        const cursor = new Date(input.from)
        cursor.setUTCHours(0, 0, 0, 0)
        while (cursor <= periodTo) {
          days.push(isoDay(cursor))
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        }
        const dailyTotal = new Map<string, number>(days.map((d) => [d, 0]))
        const dailyIn = new Map<string, number>(days.map((d) => [d, 0]))
        const dailyOut = new Map<string, number>(days.map((d) => [d, 0]))
        for (const c of calls) {
          const key = isoDay(c.occurredAt)
          if (!dailyTotal.has(key)) continue
          dailyTotal.set(key, (dailyTotal.get(key) ?? 0) + 1)
          if (c.direction === 'inbound') dailyIn.set(key, (dailyIn.get(key) ?? 0) + 1)
          if (c.direction === 'outbound') dailyOut.set(key, (dailyOut.get(key) ?? 0) + 1)
        }

        // Customisable peak windows (CLAUDE.md §10). Active rows only.
        const peakWindowRows = await ctx.db.callPeakWindow.findMany({
          where: { archivedAt: null },
          orderBy: { createdAt: 'asc' },
        })
        const peakWindows: PeakWindowDef[] = peakWindowRows.map((w) => ({
          id: w.id,
          name: w.name,
          startMonth: w.startMonth,
          startDay: w.startDay,
          endMonth: w.endMonth,
          endDay: w.endDay,
          daysOfWeek: w.daysOfWeek,
          startHour: w.startHour,
          endHour: w.endHour,
          year: w.year,
          color: w.color,
        }))

        // Peak time matrix [dow Mon=0..Sun=6][hour 0..23] + hourly throughput,
        // both on the Europe/London clock so they line up with the configured
        // peak windows and the team's lived experience. We also classify each
        // call as peak / off-peak in the same pass.
        const peak: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0))
        const hourly = new Array(24).fill(0) as number[]
        const peakCellCount: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0))
        let peakCalls = 0
        let peakAnswered = 0
        let peakTalkSec = 0
        const perWindowCalls = new Map<string, number>(peakWindows.map((w) => [w.id, 0]))
        const perWindowAnswered = new Map<string, number>(peakWindows.map((w) => [w.id, 0]))
        for (const c of calls) {
          const lp = londonParts(c.occurredAt)
          ;(peak[lp.dow] as number[])[lp.hour] = ((peak[lp.dow] as number[])[lp.hour] ?? 0) + 1
          hourly[lp.hour] = (hourly[lp.hour] ?? 0) + 1
          if (peakWindows.length > 0 && isPeakInstant(peakWindows, lp)) {
            const answered = !c.isVoicemail && c.durationSec > 0
            peakCalls += 1
            if (answered) peakAnswered += 1
            peakTalkSec += c.durationSec
            ;(peakCellCount[lp.dow] as number[])[lp.hour] =
              ((peakCellCount[lp.dow] as number[])[lp.hour] ?? 0) + 1
            for (const w of peakWindows) {
              if (instantMatchesWindow(w, lp)) {
                perWindowCalls.set(w.id, (perWindowCalls.get(w.id) ?? 0) + 1)
                if (answered) perWindowAnswered.set(w.id, (perWindowAnswered.get(w.id) ?? 0) + 1)
              }
            }
          }
        }
        // Busiest peak day/hour slot (for the headline + PDF).
        let busiest: { dow: number; hour: number; count: number } | null = null
        for (let d = 0; d < 7; d += 1) {
          for (let h = 0; h < 24; h += 1) {
            const ct = (peakCellCount[d] as number[])[h] ?? 0
            if (ct > 0 && (!busiest || ct > busiest.count)) busiest = { dow: d, hour: h, count: ct }
          }
        }
        const offPeakCalls = kpis.total - peakCalls
        const offPeakAnswered = kpis.answered - peakAnswered

        // Duration distribution buckets for answered calls only.
        const DURATION_BUCKETS = [
          { key: 'lt_30s', label: '<30s', max: 30 },
          { key: '30s_2m', label: '30s–2m', max: 120 },
          { key: '2m_5m', label: '2m–5m', max: 300 },
          { key: '5m_15m', label: '5m–15m', max: 900 },
          { key: 'gt_15m', label: '15m+', max: Infinity },
        ] as const
        const durationBucketCounts = DURATION_BUCKETS.map(() => 0)
        for (const c of calls) {
          if (c.isVoicemail || c.durationSec === 0) continue
          const idx = DURATION_BUCKETS.findIndex((b) => c.durationSec < b.max)
          const safe = idx === -1 ? DURATION_BUCKETS.length - 1 : idx
          durationBucketCounts[safe] = (durationBucketCounts[safe] ?? 0) + 1
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

        // Recent missed + voicemail trays (last 20 each, newest first).
        const missedRecent = calls
          .filter((c) => !c.isVoicemail && c.durationSec === 0)
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
          .slice(0, 20)
        const voicemailRecent = calls
          .filter((c) => c.isVoicemail)
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
          .slice(0, 20)
        const trayContactIds = Array.from(
          new Set(
            [...missedRecent, ...voicemailRecent]
              .map((c) => c.contactId)
              .filter((x): x is string => Boolean(x)),
          ),
        )
        const trayContacts =
          trayContactIds.length > 0
            ? await ctx.db.contact.findMany({
                where: { id: { in: trayContactIds } },
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phoneE164: true,
                },
              })
            : []
        const trayMap = new Map(trayContacts.map((c) => [c.id, c]))
        function fmtTrayName(contactId: string | null, fallback: string | null): string {
          if (!contactId) return fallback ?? 'Unknown'
          const c = trayMap.get(contactId)
          if (!c) return fallback ?? contactId.slice(0, 8)
          const n = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()
          return n || c.email || c.phoneE164 || fallback || contactId.slice(0, 8)
        }
        const missedTray = missedRecent.map((c) => ({
          callId: c.callId,
          contactId: c.contactId,
          name: fmtTrayName(c.contactId, c.rawDigits ?? c.callId),
          direction: c.direction,
          occurredAt: c.occurredAt,
        }))
        const voicemailTray = voicemailRecent.map((c) => ({
          callId: c.callId,
          contactId: c.contactId,
          name: fmtTrayName(c.contactId, c.rawDigits ?? c.callId),
          direction: c.direction,
          occurredAt: c.occurredAt,
        }))

        function delta(curr: number, prev: number): number {
          return curr - prev
        }

        // --- Weekly bucketing (hours + calls) -----------------------------
        // ISO week starts on Monday. We snap to Monday and bucket by week.
        function isoWeekKey(d: Date): string {
          const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
          const dow = day.getUTCDay() // 0=Sun..6=Sat
          const offset = dow === 0 ? -6 : 1 - dow
          day.setUTCDate(day.getUTCDate() + offset)
          return isoDay(day)
        }
        const weekStarts: string[] = []
        const wCursor = new Date(input.from)
        wCursor.setUTCHours(0, 0, 0, 0)
        const wDow = wCursor.getUTCDay()
        wCursor.setUTCDate(wCursor.getUTCDate() + (wDow === 0 ? -6 : 1 - wDow))
        while (wCursor <= periodTo) {
          weekStarts.push(isoDay(wCursor))
          wCursor.setUTCDate(wCursor.getUTCDate() + 7)
        }
        const weeklyCallsMap = new Map<string, number>(weekStarts.map((w) => [w, 0]))
        const weeklyHoursMap = new Map<string, number>(weekStarts.map((w) => [w, 0]))
        for (const c of calls) {
          const wk = isoWeekKey(c.occurredAt)
          if (!weeklyCallsMap.has(wk)) continue
          weeklyCallsMap.set(wk, (weeklyCallsMap.get(wk) ?? 0) + 1)
          weeklyHoursMap.set(
            wk,
            (weeklyHoursMap.get(wk) ?? 0) + c.durationSec / 3600,
          )
        }

        // --- Cold-call detection ------------------------------------------
        // A call is "cold" when it's outbound AND no earlier interaction of
        // any kind exists for the contact — i.e. this call IS the first
        // touch. We query each candidate contact's earliest interaction once.
        const contactIdsWithCalls = Array.from(
          new Set(
            calls
              .filter((c) => c.direction === 'outbound' && c.contactId)
              .map((c) => c.contactId as string),
          ),
        )
        const earliestByContact = contactIdsWithCalls.length
          ? await ctx.db.interaction.groupBy({
              by: ['contactId'],
              where: {
                contactId: { in: contactIdsWithCalls },
                deletedAt: null,
              },
              _min: { occurredAt: true },
            })
          : []
        const earliestMap = new Map<string, Date>()
        for (const e of earliestByContact) {
          if (e.contactId && e._min.occurredAt) {
            earliestMap.set(e.contactId, e._min.occurredAt)
          }
        }
        let coldCalls = 0
        let coldTalkSec = 0
        let coldAnswered = 0
        for (const c of calls) {
          if (c.direction !== 'outbound' || !c.contactId) continue
          const earliest = earliestMap.get(c.contactId)
          if (!earliest) continue
          // Cold = the contact's earliest interaction in the DB is at-or-after
          // this call's occurredAt (tolerance 60s for the multi-event call
          // grouping we do above).
          if (earliest.getTime() >= c.occurredAt.getTime() - 60_000) {
            coldCalls += 1
            coldTalkSec += c.durationSec
            if (!c.isVoicemail && c.durationSec > 0) coldAnswered += 1
          }
        }

        // --- Provider mix --------------------------------------------------
        const providerCounts = {
          aircall: 0,
          google_voice: 0,
          manual: 0,
        }
        for (const c of calls) providerCounts[c.provider] += 1

        return {
          period: { from: input.from, to: input.to },
          previousPeriod: { from: prevFrom, to: prevTo },
          direction: input.direction,
          provider: input.provider,
          kpis,
          deltas: {
            total: delta(kpis.total, prevKpis.total),
            answered: delta(kpis.answered, prevKpis.answered),
            voicemails: delta(kpis.voicemails, prevKpis.voicemails),
            missed: delta(kpis.missed, prevKpis.missed),
            inbound: delta(kpis.inbound, prevKpis.inbound),
            outbound: delta(kpis.outbound, prevKpis.outbound),
            avgDurationSec: delta(kpis.avgDurationSec, prevKpis.avgDurationSec),
            totalTalkSec: delta(kpis.totalTalkSec, prevKpis.totalTalkSec),
            answeredRate: kpis.answeredRate - prevKpis.answeredRate,
          },
          coldCalling: {
            calls: coldCalls,
            answered: coldAnswered,
            talkSec: coldTalkSec,
            connectRate: coldCalls === 0 ? 0 : coldAnswered / coldCalls,
          },
          providerMix: providerCounts,
          daily: {
            labels: days,
            counts: days.map((d) => dailyTotal.get(d) ?? 0),
            inbound: days.map((d) => dailyIn.get(d) ?? 0),
            outbound: days.map((d) => dailyOut.get(d) ?? 0),
          },
          weekly: {
            labels: weekStarts,
            calls: weekStarts.map((w) => weeklyCallsMap.get(w) ?? 0),
            hours: weekStarts.map(
              (w) => Math.round((weeklyHoursMap.get(w) ?? 0) * 10) / 10,
            ),
          },
          hourly,
          durationBuckets: DURATION_BUCKETS.map((b, i) => ({
            key: b.key,
            label: b.label,
            count: durationBucketCounts[i] ?? 0,
          })),
          peak,
          peakWindows: peakWindows.map((w) => ({ ...w, labels: describePeakWindow(w) })),
          peakStats: {
            configured: peakWindows.length > 0,
            windowCount: peakWindows.length,
            peakCalls,
            offPeakCalls,
            peakShare: kpis.total ? peakCalls / kpis.total : 0,
            peakAnswered,
            peakAnsweredRate: peakCalls ? peakAnswered / peakCalls : 0,
            offPeakAnswered,
            offPeakAnsweredRate: offPeakCalls ? offPeakAnswered / offPeakCalls : 0,
            peakTalkSec,
            busiest,
            byWindow: peakWindows.map((w) => ({
              id: w.id,
              name: w.name,
              color: w.color,
              calls: perWindowCalls.get(w.id) ?? 0,
              answered: perWindowAnswered.get(w.id) ?? 0,
            })),
          },
          topContacts,
          missedTray,
          voicemailTray,
        }
      }),

    // CRUD for the customisable peak-times windows (CLAUDE.md §10). Manager+
    // (same gate as the rest of Reports). Config rows — no Contact/finance/
    // safeguarding data — so no audit row is required (§20.1).
    peakWindows: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        assertReports(requireUser(ctx))
        const rows = await ctx.db.callPeakWindow.findMany({
          where: { archivedAt: null },
          orderBy: { createdAt: 'asc' },
        })
        return rows.map((w) => ({
          id: w.id,
          name: w.name,
          startMonth: w.startMonth,
          startDay: w.startDay,
          endMonth: w.endMonth,
          endDay: w.endDay,
          daysOfWeek: w.daysOfWeek,
          startHour: w.startHour,
          endHour: w.endHour,
          year: w.year,
          color: w.color,
        }))
      }),

      create: protectedProcedure.input(PeakWindowInput).mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertReports(user)
        if (input.endHour <= input.startHour) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'End hour must be after the start hour' })
        }
        const row = await ctx.db.callPeakWindow.create({
          data: {
            id: createId(),
            name: input.name,
            startMonth: input.startMonth,
            startDay: input.startDay,
            endMonth: input.endMonth,
            endDay: input.endDay,
            daysOfWeek: input.daysOfWeek,
            startHour: input.startHour,
            endHour: input.endHour,
            year: input.year,
            color: input.color,
            createdById: user.id,
            updatedById: user.id,
          },
          select: { id: true },
        })
        return { id: row.id }
      }),

      update: protectedProcedure.input(PeakWindowUpdateInput).mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertReports(user)
        if (input.endHour <= input.startHour) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'End hour must be after the start hour' })
        }
        const existing = await ctx.db.callPeakWindow.findFirst({
          where: { id: input.id, archivedAt: null },
          select: { id: true },
        })
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
        await ctx.db.callPeakWindow.update({
          where: { id: input.id },
          data: {
            name: input.name,
            startMonth: input.startMonth,
            startDay: input.startDay,
            endMonth: input.endMonth,
            endDay: input.endDay,
            daysOfWeek: input.daysOfWeek,
            startHour: input.startHour,
            endHour: input.endHour,
            year: input.year,
            color: input.color,
            updatedById: user.id,
          },
        })
        return { id: input.id }
      }),

      archive: protectedProcedure
        .input(z.object({ id: z.string() }))
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertReports(user)
          await ctx.db.callPeakWindow.updateMany({
            where: { id: input.id, archivedAt: null },
            data: { archivedAt: new Date(), updatedById: user.id },
          })
          return { id: input.id }
        }),
    }),
  }),

  // Complaints analytics (CLAUDE.md §27). Period-scoped on complaints OPENED in
  // the window, plus a live standing-backlog snapshot and the customers with the
  // most active complaints. "Active" = open | in_progress (mirrors the queue).
  complaints: router({
    summary: protectedProcedure.input(PeriodInput).query(async ({ ctx, input }) => {
      assertReports(requireUser(ctx))
      const from = input.from
      const periodTo = endOfUtcDay(input.to)
      const ACTIVE = ['open', 'in_progress'] as const

      const [activeBacklog, openedRows, resolvedRows, activeGroups] = await Promise.all([
        ctx.db.complaint.count({ where: { deletedAt: null, status: { in: [...ACTIVE] } } }),
        ctx.db.complaint.findMany({
          where: { deletedAt: null, createdAt: { gte: from, lte: periodTo } },
          select: { status: true, severity: true, category: true, createdAt: true },
          take: 20_000,
        }),
        ctx.db.complaint.findMany({
          where: { deletedAt: null, resolvedAt: { gte: from, lte: periodTo } },
          select: { createdAt: true, resolvedAt: true },
          take: 20_000,
        }),
        ctx.db.complaint.groupBy({
          by: ['contactId'],
          where: { deletedAt: null, status: { in: [...ACTIVE] } },
          _count: { _all: true },
        }),
      ])

      const openedInPeriod = openedRows.length
      const resolvedInPeriod = resolvedRows.length
      const resolutionHours = resolvedRows
        .map((r) =>
          r.resolvedAt ? (r.resolvedAt.getTime() - r.createdAt.getTime()) / 3_600_000 : null,
        )
        .filter((n): n is number => n != null && n >= 0)
      const avgResolutionHours = resolutionHours.length
        ? Math.round((resolutionHours.reduce((s, n) => s + n, 0) / resolutionHours.length) * 10) /
          10
        : null

      function isoDay(d: Date): string {
        const y = d.getUTCFullYear()
        const m = String(d.getUTCMonth() + 1).padStart(2, '0')
        const day = String(d.getUTCDate()).padStart(2, '0')
        return `${y}-${m}-${day}`
      }
      const days: string[] = []
      const cursor = new Date(from)
      cursor.setUTCHours(0, 0, 0, 0)
      while (cursor <= periodTo) {
        days.push(isoDay(cursor))
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      }
      const openedByDay = new Map<string, number>(days.map((d) => [d, 0]))

      const byStatus = { open: 0, in_progress: 0, resolved: 0, dismissed: 0 }
      const bySeverity = { low: 0, medium: 0, high: 0 }
      const byCategoryMap = new Map<string, number>()
      for (const r of openedRows) {
        const k = isoDay(r.createdAt)
        if (openedByDay.has(k)) openedByDay.set(k, (openedByDay.get(k) ?? 0) + 1)
        if (r.status in byStatus) byStatus[r.status as keyof typeof byStatus] += 1
        if (r.severity in bySeverity) bySeverity[r.severity as keyof typeof bySeverity] += 1
        const cat = r.category?.trim() || 'Uncategorised'
        byCategoryMap.set(cat, (byCategoryMap.get(cat) ?? 0) + 1)
      }
      const byCategory = [...byCategoryMap.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)

      const topGroups = activeGroups
        .map((g) => ({ contactId: g.contactId, count: g._count._all }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
      const topContacts = topGroups.length
        ? await ctx.db.contact.findMany({
            where: { id: { in: topGroups.map((g) => g.contactId) } },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : []
      const nameById = new Map(
        topContacts.map((c) => [
          c.id,
          [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || 'Contact',
        ]),
      )
      const topCustomers = topGroups.map((g) => ({
        id: g.contactId,
        name: nameById.get(g.contactId) ?? 'Contact',
        activeCount: g.count,
      }))

      return {
        kpis: { activeBacklog, openedInPeriod, resolvedInPeriod, avgResolutionHours },
        daily: { labels: days, opened: days.map((d) => openedByDay.get(d) ?? 0) },
        byStatus,
        bySeverity,
        byCategory,
        topCustomers,
      }
    }),
  }),
})
