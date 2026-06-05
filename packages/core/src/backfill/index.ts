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

export type { BackfillJob, BackfillProvider } from '@prisma/client'

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

  const existing = await db.backfillJob.findFirst({
    where: {
      provider: input.provider,
      agentId,
      status: { in: ['pending', 'running'] },
    },
    select: { id: true },
  })
  if (existing) {
    throw new BackfillAlreadyRunningError(input.provider, agentId, existing.id)
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

export async function markBackfillRunning(
  db: DbClient,
  jobId: string,
): Promise<void> {
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
  jobId: string,
  counts: BackfillCounts,
): Promise<void> {
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
  jobId: string,
  input: CompleteBackfillInput,
): Promise<void> {
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
  jobId: string,
  error: string,
  requestId: string,
): Promise<void> {
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

export async function markBackfillCancelled(
  db: DbClient,
  jobId: string,
  ctx: BackfillCtx,
): Promise<void> {
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
