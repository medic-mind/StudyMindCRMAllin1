// ADR 0017 — 90-day historic-data backfill.
//
// `startBackfill` is called from the OAuth callback (Gmail), the Trengo
// connect flow, and the per-provider "Backfill last 90 days" admin button
// (Aircall, Slack). It refuses if a pending or running job already exists
// for the same (provider, agentId) so a double-click cannot kick off two
// concurrent imports.
//
// The per-provider worker lives in `packages/integrations/<svc>/backfill.ts`
// and is wired into the Inngest serve handler at
// `apps/web/app/api/inngest/route.ts`. The worker is responsible for:
//   - marking the job `running` on first step;
//   - paging through the provider's history with `lastEventId` as the
//     resumability cursor;
//   - persisting one Interaction per matched Contact (or skipping when no
//     match);
//   - incrementing the progress counters;
//   - emitting `backfill.completed` with a single summary audit row when
//     done. We do NOT audit per imported message — too noisy per CLAUDE.md
//     §17 and the hard rules in the task brief.
//
// The functions in this file are pure data writers — they take an injected
// db client and an injected event sender, and never reach out themselves.
// This keeps `packages/core` free of cross-cutting Inngest / integrations
// imports (CLAUDE.md §5 module boundaries).

import { createId } from '@paralleldrive/cuid2'
import type { BackfillJob, BackfillProvider, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry, type DbClient } from '@studymind/audit'

import { logger } from '../logger'

export type { BackfillJob, BackfillProvider } from '@prisma/client'

/**
 * A pending/running backfill whose progress has not advanced for this long is
 * treated as orphaned: the web service that serves Inngest was almost always
 * redeployed mid-run, so the Inngest run was abandoned and the row would sit
 * `running`/`pending` forever — blocking every retry via
 * `BackfillAlreadyRunningError` and showing "Importing 0 items…" indefinitely.
 * `startBackfill` supersedes such a job instead of blocking, so an operator can
 * always re-trigger an import; the integrations diagnostics reuse this window
 * to flag stalled jobs.
 */
export const STALE_BACKFILL_MS = 15 * 60 * 1000

/** Minimal interface a job-event sender (the Inngest client) must satisfy. */
export interface BackfillEventSender {
  send(event: { name: string; data: Record<string, unknown> }): Promise<unknown>
}

export interface BackfillCtx {
  actorId: string | null
  requestId: string
}

export interface StartBackfillInput {
  provider: BackfillProvider
  /**
   * Per-agent provider tokens (Gmail, Trengo) supply this. Aircall + Slack
   * use a shared service token so `agentId` may be null.
   */
  agentId?: string | null
  /** Window length in days. Default 90. */
  windowDays?: number
  /** Anchor for the window. Defaults to "now". */
  windowTo?: Date
  /**
   * Trengo manual import only: when true, the worker creates a lightweight
   * Contact for a conversation whose sender is not already in the CRM
   * (instead of skipping it). Other providers ignore this. Defaults to false
   * so the auto-on-connect backfill keeps its original "matched only"
   * behaviour.
   */
  createContacts?: boolean
  ctx: BackfillCtx
}

export interface StartBackfillResult {
  jobId: string
  status: BackfillJob['status']
}

export class BackfillAlreadyRunningError extends Error {
  override readonly name = 'BackfillAlreadyRunningError'
  constructor(
    public readonly provider: BackfillProvider,
    public readonly agentId: string | null,
    public readonly existingJobId: string,
  ) {
    super(
      `A ${provider} backfill is already pending or running for agent ${agentId ?? '<shared>'}`,
    )
  }
}

/**
 * Begin a 90-day historic-data backfill for `provider`.
 *
 * Idempotent: when a pending or running job already exists for the same
 * (provider, agentId), the existing jobId is thrown back so the caller can
 * link to its status without creating a duplicate.
 *
 * On success the function inserts a BackfillJob row in `pending` state,
 * writes a single `backfill.started` audit row, and fires the per-provider
 * Inngest event. The worker takes over from there.
 */
export async function startBackfill(
  db: PrismaClient,
  sender: BackfillEventSender,
  input: StartBackfillInput,
): Promise<StartBackfillResult> {
  const windowDays = input.windowDays ?? 90
  const windowTo = input.windowTo ?? new Date()
  const windowFrom = new Date(windowTo.getTime() - windowDays * 24 * 60 * 60 * 1000)
  const agentId = input.agentId ?? null

  // A genuinely in-flight job blocks a duplicate (idempotent). But an orphaned
  // job — one whose progress has not advanced for STALE_BACKFILL_MS — is
  // superseded (marked failed) so the operator is never deadlocked behind a
  // run the worker abandoned. `updatedAt` advances on every progress write, so
  // a healthy import is never mistaken for stale.
  const existing = await db.backfillJob.findFirst({
    where: {
      provider: input.provider,
      agentId,
      status: { in: ['pending', 'running'] },
    },
    select: { id: true, updatedAt: true },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    const stale = Date.now() - existing.updatedAt.getTime() > STALE_BACKFILL_MS
    if (!stale) {
      throw new BackfillAlreadyRunningError(input.provider, agentId, existing.id)
    }
    await markBackfillFailed(
      db,
      existing.id,
      'Superseded — the previous run stalled (the worker restarted mid-import or never picked it up).',
      input.ctx.requestId,
    )
    logger.warn(
      { provider: input.provider, agentId, supersededJobId: existing.id },
      'backfill: superseding a stalled job and starting a fresh one',
    )
  }

  const jobId = createId()
  await db.backfillJob.create({
    data: {
      id: jobId,
      provider: input.provider,
      agentId,
      windowFrom,
      windowTo,
      status: 'pending',
      createdById: input.ctx.actorId,
      updatedById: input.ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: input.ctx.actorId,
    action: 'backfill.started',
    target: { type: 'BackfillJob', id: jobId },
    requestId: input.ctx.requestId,
    after: {
      provider: input.provider,
      agentId,
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
      windowDays,
    },
  })

  await sender.send({
    name: `backfill/${input.provider}.requested`,
    data: {
      jobId,
      provider: input.provider,
      agentId,
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
      createContacts: input.createContacts ?? false,
    },
  })

  return { jobId, status: 'pending' }
}

// -----------------------------------------------------------------------------
// Worker-side helpers. Workers call these to drive a job through its
// lifecycle. Auditing is deferred to a single summary row at completion
// (CLAUDE.md §17 — backfills can write tens of thousands of Interactions, so
// we do NOT audit per write).
// -----------------------------------------------------------------------------

/**
 * A backfill event arriving with no jobId is malformed or stale (e.g. an event
 * queued before a deploy/sync). Rather than crash on
 * `update({ where: { id: undefined } })` — which throws and triggers an Inngest
 * retry storm that blocks the queue — we log and skip the tracking write. The
 * worker's own (idempotent) data import still runs; fresh triggers always carry
 * a jobId. This also closes a latent bug where `markBackfillRunning`'s
 * `updateMany({ where: { id: undefined } })` would have matched ALL pending rows.
 */
function ensureJobId(jobId: string | undefined, op: string): jobId is string {
  if (!jobId) {
    logger.error({ op }, 'backfill: event missing jobId — skipping tracking write')
    return false
  }
  return true
}

export async function markBackfillRunning(
  db: DbClient,
  jobId: string | undefined,
): Promise<void> {
  if (!ensureJobId(jobId, 'markBackfillRunning')) return
  await db.backfillJob.updateMany({
    where: { id: jobId, status: 'pending' },
    data: { status: 'running', startedAt: new Date() },
  })
}

export interface BackfillCounts {
  processed?: number
  matched?: number
  skipped?: number
  totalCount?: number | null
  lastEventId?: string | null
}

export async function incrementBackfillProgress(
  db: DbClient,
  jobId: string | undefined,
  counts: BackfillCounts,
): Promise<void> {
  if (!ensureJobId(jobId, 'incrementBackfillProgress')) return
  await db.backfillJob.update({
    where: { id: jobId },
    data: {
      processedCount: counts.processed
        ? { increment: counts.processed }
        : undefined,
      matchedCount: counts.matched ? { increment: counts.matched } : undefined,
      skippedCount: counts.skipped ? { increment: counts.skipped } : undefined,
      ...(counts.totalCount !== undefined ? { totalCount: counts.totalCount } : {}),
      ...(counts.lastEventId !== undefined ? { lastEventId: counts.lastEventId } : {}),
    },
  })
}

export interface CompleteBackfillInput {
  processed: number
  matched: number
  skipped: number
  /** Optional definitive total — used for the final percentage. */
  totalCount?: number | null
  requestId: string
}

export async function markBackfillCompleted(
  db: DbClient,
  jobId: string | undefined,
  input: CompleteBackfillInput,
): Promise<void> {
  if (!ensureJobId(jobId, 'markBackfillCompleted')) return
  const row = await db.backfillJob.update({
    where: { id: jobId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      processedCount: input.processed,
      matchedCount: input.matched,
      skippedCount: input.skipped,
      ...(input.totalCount !== undefined ? { totalCount: input.totalCount } : {}),
    },
    select: { provider: true, agentId: true },
  })
  await writeAuditLogEntry(db, {
    actorId: null,
    action: 'backfill.completed',
    target: { type: 'BackfillJob', id: jobId },
    requestId: input.requestId,
    after: {
      provider: row.provider,
      agentId: row.agentId,
      processed: input.processed,
      matched: input.matched,
      skipped: input.skipped,
      totalCount: input.totalCount ?? null,
    },
  })
}

export async function markBackfillFailed(
  db: DbClient,
  jobId: string | undefined,
  error: string,
  requestId: string,
): Promise<void> {
  if (!ensureJobId(jobId, 'markBackfillFailed')) return
  const row = await db.backfillJob.update({
    where: { id: jobId },
    data: {
      status: 'failed',
      completedAt: new Date(),
      error: error.slice(0, 2000),
    },
    select: { provider: true, agentId: true },
  })
  await writeAuditLogEntry(db, {
    actorId: null,
    action: 'backfill.failed',
    target: { type: 'BackfillJob', id: jobId },
    requestId,
    after: { provider: row.provider, agentId: row.agentId, error: error.slice(0, 500) },
  })
}

/**
 * Mark every backfill that has been pending/running with no progress for
 * longer than {@link STALE_BACKFILL_MS} as failed. An abandoned run — the web
 * service was redeployed mid-import, or Inngest never picked the job up —
 * otherwise sits `running` forever: a permanent "Importing 0 items…" banner
 * and a perpetual "stuck backfills" count in the integrations diagnostics,
 * with no way to clear it short of starting another import. `startBackfill`
 * already supersedes one such row when an operator re-triggers the same
 * provider; this self-heals them on a schedule with no operator action.
 *
 * Idempotent and safe to run often: a healthy job advances `updatedAt` on
 * every progress write, so it is never reaped; an already-failed row drops out
 * of the query. Returns the ids it reaped.
 */
export async function reapStaleBackfills(
  db: PrismaClient,
  opts: { now?: Date; requestId?: string } = {},
): Promise<string[]> {
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - STALE_BACKFILL_MS)
  const stale = await db.backfillJob.findMany({
    where: {
      status: { in: ['pending', 'running'] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
  })
  const requestId = opts.requestId ?? `backfill-reaper:${now.toISOString().slice(0, 10)}`
  for (const row of stale) {
    await markBackfillFailed(
      db,
      row.id,
      'Reaped — the import stalled (the worker restarted mid-run or never picked it up). Re-trigger the import to retry.',
      requestId,
    )
  }
  return stale.map((r) => r.id)
}

export async function markBackfillCancelled(
  db: DbClient,
  jobId: string | undefined,
  ctx: BackfillCtx,
): Promise<void> {
  if (!ensureJobId(jobId, 'markBackfillCancelled')) return
  const row = await db.backfillJob.update({
    where: { id: jobId },
    data: {
      status: 'cancelled',
      completedAt: new Date(),
      updatedById: ctx.actorId,
    },
    select: { provider: true, agentId: true },
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'backfill.cancelled',
    target: { type: 'BackfillJob', id: jobId },
    requestId: ctx.requestId,
    after: { provider: row.provider, agentId: row.agentId },
  })
}
