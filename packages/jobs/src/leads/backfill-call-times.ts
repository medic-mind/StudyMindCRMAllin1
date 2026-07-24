// Retroactive scheduled-call-time repair for existing web leads.
//
// The improved "Call day"/"Call time" parser only helps NEW leads (a lead is
// classified within seconds of arriving, so anything submitted BEFORE the
// parser shipped has a card with a blank `scheduledCallAt` — the requested
// call never reached the board). Two jobs re-parse each EXISTING lead's stored
// raw payload with that same parser and set the backing pipeline card's
// `scheduledCallAt` where it is still blank:
//
//   • `leadBackfillCallTimes` — the operator "Fill call times on old cards"
//     button. A ONE-SHOT, self-rescheduling FULL scan of every lead-with-a-card
//     (`leads/backfill-call-times.requested`). Use it for a complete historic
//     repair on demand.
//   • `leadHealRecentCallTimes` — a RECURRING (every 30 min), BOUNDED auto-heal
//     over leads from the last `LEAD_CALL_TIME_HEAL_WINDOW_DAYS` days. It fills
//     pre-parser cards whose requested call is still upcoming WITHOUT anyone
//     clicking a button, and self-heals any future parse-miss. This is what
//     guarantees a card like Shamin Anari's (enquired the day before the parser
//     shipped, requesting a call "Friday 24 Jul 10:00") surfaces its call time
//     on the board on its own.
//
// Both are idempotent: they only touch cards whose `scheduledCallAt` is null,
// so a re-run converges. Year inference uses each lead's OWN submission date
// (`createdAt`), so "Friday 24 Jul" resolves relative to when they enquired,
// not today. One summary audit row at start + completion (§17 — never per-row).

import { writeAuditLogEntry } from '@studymind/audit'
import { londonWallToUtc, normaliseLead, type RawLeadInput } from '@studymind/core/lead'
import { recordCronRun } from '@studymind/core/observability/cron-heartbeat'
import { db } from '@studymind/db'

import { inngest } from '../client'

const BATCH_SIZE = 500

interface RequestedData {
  jobId: string
  cursorId?: string | null
  scanned?: number
  updated?: number
}

/**
 * The UTC scheduled-call instant for a lead's raw payload, using the lead's
 * submission date as the reference for year-less / weekday call dates. Returns
 * null when the payload carries no parseable call time. Pure — unit-tested.
 */
export function scheduledCallFromLead(rawPayload: unknown, submittedAt: Date): Date | null {
  const normalised = normaliseLead(rawPayload as unknown as RawLeadInput, { now: submittedAt })
  return normalised.preferredWhen ? londonWallToUtc(normalised.preferredWhen) : null
}

/** A lead row with just what the call-time repair needs. */
export interface CallTimeLead {
  cardId: string | null
  rawPayload: unknown
  createdAt: Date
}

/**
 * Decide which cards to stamp with a scheduled call time. Pure — unit-tested.
 * A lead contributes a write only when its card is still blank (`blankCardIds`)
 * AND its payload carries a parseable call time. Shared by the one-shot full
 * backfill and the recurring auto-heal so both apply the exact same rule.
 */
export function planCallTimeHeals(
  leads: readonly CallTimeLead[],
  blankCardIds: ReadonlySet<string>,
): Array<{ cardId: string; when: Date }> {
  const writes: Array<{ cardId: string; when: Date }> = []
  for (const lead of leads) {
    if (!lead.cardId || !blankCardIds.has(lead.cardId)) continue
    const when = scheduledCallFromLead(lead.rawPayload, lead.createdAt)
    if (when) writes.push({ cardId: lead.cardId, when })
  }
  return writes
}

export const leadBackfillCallTimes = inngest.createFunction(
  {
    id: 'leads/backfill-call-times',
    name: 'Backfill scheduled call times onto existing lead cards',
    // Single runner — the function id is the advisory lock so concurrent
    // invocations queue rather than race.
    concurrency: { limit: 1 },
    retries: 3,
  },
  { event: 'leads/backfill-call-times.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as RequestedData
    const { jobId } = data
    const cursorId = data.cursorId ?? null
    const scannedSoFar = data.scanned ?? 0
    const updatedSoFar = data.updated ?? 0

    if (!cursorId) {
      await step.run('audit-start', async () =>
        writeAuditLogEntry(db, {
          actorId: null,
          action: 'lead.call_times_backfill_requested',
          target: { type: 'System', id: jobId },
          requestId: jobId,
          after: { batchSize: BATCH_SIZE },
        }),
      )
    }

    // Next page of leads that produced a card. Keyset on id. Not wrapped in
    // step.run — the query is idempotent and Inngest jsonifies step results.
    const leads = await db.lead.findMany({
      where: {
        cardId: { not: null },
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, cardId: true, rawPayload: true, createdAt: true },
    })

    if (leads.length === 0) {
      await step.run('audit-complete', async () =>
        writeAuditLogEntry(db, {
          actorId: null,
          action: 'lead.call_times_backfilled',
          target: { type: 'System', id: jobId },
          requestId: jobId,
          after: { scanned: scannedSoFar, updated: updatedSoFar },
        }),
      )
      logger.info({ jobId, scanned: scannedSoFar, updated: updatedSoFar }, 'lead call-time backfill done')
      return { ok: true, scanned: scannedSoFar, updated: updatedSoFar }
    }

    // Only cards that still have no scheduled call are candidates (idempotent).
    const cardIds = leads.map((l) => l.cardId).filter((id): id is string => Boolean(id))
    const blankCards = await db.card.findMany({
      where: { id: { in: cardIds }, scheduledCallAt: null, archivedAt: null },
      select: { id: true },
    })
    const blank = new Set(blankCards.map((c) => c.id))

    let updated = 0
    for (const w of planCallTimeHeals(leads, blank)) {
      // Re-check null in the write so a concurrent set never gets clobbered.
      const res = await db.card.updateMany({
        where: { id: w.cardId, scheduledCallAt: null },
        data: { scheduledCallAt: w.when },
      })
      updated += res.count
    }

    const nextCursor = leads[leads.length - 1]!.id
    const nextScanned = scannedSoFar + leads.length
    const nextUpdated = updatedSoFar + updated

    await step.sendEvent('schedule-next-batch', {
      name: 'leads/backfill-call-times.requested',
      data: { jobId, cursorId: nextCursor, scanned: nextScanned, updated: nextUpdated },
    })

    return { ok: true, batch: leads.length, updated, scanned: nextScanned }
  },
)

// Recurring auto-heal window. A requested call time only has value while the
// call is still upcoming, so we scan a recent window rather than all history
// (the operator button covers the full historic sweep). Env-overridable.
const HEAL_WINDOW_DAYS = Math.max(
  1,
  Number(process.env['LEAD_CALL_TIME_HEAL_WINDOW_DAYS'] ?? 90) || 90,
)
// Go-live cutoff — the heal ONLY touches leads submitted BEFORE the
// "Call day"/"Call time" parser shipped (the actual bug: those cards never got
// a scheduled call). It must never touch a MODERN card, because on a post-parser
// card `scheduledCallAt: null` can mean "an agent deliberately cleared the chip"
// (e.g. the customer declined that slot), and re-populating it from the old
// enquiry would be a §3 silent mutation that reverts a human decision. Mirrors
// the DD-issues / complaint cutoff idiom. Env-overridable; a fixed date means
// the heal self-expires once the backlog ages out of the recency window.
function resolveHealCutoff(): Date {
  const raw = process.env['LEAD_CALL_TIME_HEAL_BEFORE'] ?? '2026-07-24'
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? new Date('2026-07-24T00:00:00Z') : parsed
}
const HEAL_BEFORE = resolveHealCutoff()

/**
 * The lead-submission date window the recurring heal scans, for a given `now`:
 * `[now − HEAL_WINDOW_DAYS, HEAL_BEFORE)`. The upper bound is the parser go-live
 * cutoff (never touch modern cards, §3); the lower bound keeps it to leads whose
 * requested call may still be upcoming. Pure — unit-tested.
 */
export function healWindowBounds(now: Date): { gte: Date; lt: Date } {
  return { gte: new Date(now.getTime() - HEAL_WINDOW_DAYS * 86_400_000), lt: HEAL_BEFORE }
}
// The ids-only scan is keyset-paginated so EVERY in-window lead is covered, not
// just the newest N — the pre-parser backlog sits at the OLDER end of the
// window, so a `take: N newest` would starve exactly the cards we need to heal
// on any funnel with more than N leads in the window. Each page is bounded, and
// the whole walk stays cheap because raw payloads are pulled ONLY for blanks.
const HEAL_PAGE = 1000
// Backstop so a single tick can't run away on a huge funnel; anything beyond is
// caught next tick or by the operator's full-scan button. Logged when hit.
const HEAL_MAX_PAGES = 60

/**
 * Recurring, bounded auto-heal: every 30 minutes, fill `scheduledCallAt` on the
 * cards of leads from the last {@link HEAL_WINDOW_DAYS} days where it is still
 * blank AND the stored payload carries a parseable call time. This makes
 * pre-parser cards (submitted before the "Call day"/"Call time" parser shipped)
 * surface their requested call on the board on their own — no operator button.
 *
 * Cheap at steady state: it keyset-walks the window fetching only ids to find
 * blank cards, then pulls the raw payload ONLY for the blank ones (near-zero
 * once the backlog drains). Idempotent — a concurrent set is never clobbered
 * (the write re-checks null), so it is safe to run alongside the full backfill.
 */
export const leadHealRecentCallTimes = inngest.createFunction(
  {
    id: 'leads/heal-recent-call-times',
    name: 'Auto-heal scheduled call times on recent lead cards',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/30 * * * *' },
  async ({ step, logger }) => {
    const startedAt = Date.now()
    const result = await step.run('heal', async () => {
      const { gte, lt } = healWindowBounds(new Date(startedAt))
      let cursorId: string | null = null
      let scanned = 0
      let updated = 0
      let capped = false
      for (let page = 0; ; page++) {
        if (page >= HEAL_MAX_PAGES) {
          capped = true
          break
        }
        // 1. Next page of in-window lead cards — ids only (cheap), keyset on id.
        //    createdAt is bounded BOTH ends: recent enough that the call may be
        //    upcoming, AND before the parser go-live cutoff (never touch a
        //    modern card an agent may have deliberately cleared, §3).
        const recent: Array<{ id: string; cardId: string | null }> =
          await db.lead.findMany({
            where: {
              cardId: { not: null },
              createdAt: { gte, lt },
              ...(cursorId ? { id: { gt: cursorId } } : {}),
            },
            orderBy: { id: 'asc' },
            take: HEAL_PAGE,
            select: { id: true, cardId: true },
          })
        if (recent.length === 0) break
        scanned += recent.length
        cursorId = recent[recent.length - 1]!.id

        // 2. Which of those cards still have no scheduled call?
        const cardIds = recent
          .map((r) => r.cardId)
          .filter((id): id is string => Boolean(id))
        const blankCards = await db.card.findMany({
          where: { id: { in: cardIds }, scheduledCallAt: null, archivedAt: null },
          select: { id: true },
        })
        if (blankCards.length > 0) {
          const blank = new Set(blankCards.map((c) => c.id))
          // 3. Pull raw payloads ONLY for the leads whose card is blank.
          const blankLeadIds = recent
            .filter((r) => r.cardId && blank.has(r.cardId))
            .map((r) => r.id)
          const leads = await db.lead.findMany({
            where: { id: { in: blankLeadIds } },
            select: { id: true, cardId: true, rawPayload: true, createdAt: true },
          })
          // 4. Fill (idempotent — the write re-checks the card is still blank).
          for (const w of planCallTimeHeals(leads, blank)) {
            const res = await db.card.updateMany({
              where: { id: w.cardId, scheduledCallAt: null },
              data: { scheduledCallAt: w.when },
            })
            updated += res.count
          }
        }
        if (recent.length < HEAL_PAGE) break
      }
      return { scanned, updated, capped }
    })

    await step.run('heartbeat', () =>
      recordCronRun(db, {
        functionId: 'leads/heal-recent-call-times',
        success: true,
        durationMs: Date.now() - startedAt,
      }),
    )
    if (result.updated > 0 || result.capped) {
      // Surface the cap so a starved backlog is never silent (§ no silent caps).
      logger.info(result, 'lead.call_times.auto_healed')
    }
    return result
  },
)

export const LEAD_CALL_TIME_BACKFILL_FUNCTIONS = [
  leadBackfillCallTimes,
  leadHealRecentCallTimes,
]
