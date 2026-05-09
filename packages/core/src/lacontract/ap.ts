// AP (Section 19) placement helpers. CLAUDE.md §43.4.
//
// Pure helpers + a small persistence layer for placement reviews. The
// reconciliation engine and the LAInvoice generator both consume
// `apReviewOverdue` to refuse work on a learner whose review is past due.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

type DbWriter = PrismaClient | Prisma.TransactionClient

export interface APPlacementSnapshot {
  id: string
  familyId: string
  apStartDate: Date
  apReviewDate: Date
  apEndDate: Date | null
  statutoryReason: string
  reviewStatus: 'pending' | 'overdue' | 'completed'
}

export interface ActorCtx {
  actorId: string
  requestId: string
}

/**
 * Returns true when the placement has a review date in the past and the
 * review has not been marked completed. Pure — does not touch the DB.
 */
export function apReviewOverdue(
  placement: Pick<APPlacementSnapshot, 'apReviewDate' | 'reviewStatus'> | null,
  now: Date = new Date(),
): boolean {
  if (!placement) return false
  if (placement.reviewStatus === 'completed') return false
  return placement.apReviewDate < now
}

export interface CompleteApReviewInput {
  familyId: string
  /** Optional next review date — typically 12 weeks out for AP. */
  nextReviewDate?: Date
}

/**
 * Mark the AP review complete for a learner family. Optionally schedules
 * the next review date. Writes a tutor-style review-completed Interaction
 * and an audit row.
 */
export async function completeApReview(
  db: DbWriter,
  input: CompleteApReviewInput,
  ctx: ActorCtx,
): Promise<{ placementId: string }> {
  const placement = await db.aPPlacement.findUniqueOrThrow({
    where: { familyId: input.familyId },
    select: { id: true, apReviewDate: true, reviewStatus: true },
  })

  await db.aPPlacement.update({
    where: { familyId: input.familyId },
    data: {
      reviewStatus: 'completed',
      apReviewDate: input.nextReviewDate ?? placement.apReviewDate,
      updatedById: ctx.actorId,
    },
  })

  // Mirror onto the Family.apPlacement JSONB for fast UI reads.
  const family = await db.family.findUnique({
    where: { id: input.familyId },
    select: { apPlacement: true },
  })
  const current = (family?.apPlacement as Record<string, unknown> | null) ?? {}
  await db.family.update({
    where: { id: input.familyId },
    data: {
      apPlacement: {
        ...current,
        reviewStatus: 'completed',
        ...(input.nextReviewDate
          ? { apReviewDate: input.nextReviewDate.toISOString() }
          : {}),
      },
      updatedById: ctx.actorId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'tutor_session_note',
      familyId: input.familyId,
      occurredAt: new Date(),
      summary: 'AP review completed',
      payload: {
        event: 'ap_placement.review_completed',
        placementId: placement.id,
        nextReviewDate: input.nextReviewDate?.toISOString() ?? null,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'ap_placement.review_completed',
    target: { type: 'APPlacement', id: placement.id },
    requestId: ctx.requestId,
    before: { reviewStatus: placement.reviewStatus },
    after: {
      reviewStatus: 'completed',
      apReviewDate: input.nextReviewDate?.toISOString() ?? placement.apReviewDate.toISOString(),
    },
  })

  return { placementId: placement.id }
}

/**
 * Fetch the placement snapshot for a Family. Returns null when none exists
 * (most Families are not AP-billed).
 */
export async function getApPlacement(
  db: DbWriter,
  familyId: string,
): Promise<APPlacementSnapshot | null> {
  const row = await db.aPPlacement.findUnique({
    where: { familyId },
    select: {
      id: true,
      familyId: true,
      apStartDate: true,
      apReviewDate: true,
      apEndDate: true,
      statutoryReason: true,
      reviewStatus: true,
    },
  })
  if (!row) return null
  return {
    id: row.id,
    familyId: row.familyId,
    apStartDate: row.apStartDate,
    apReviewDate: row.apReviewDate,
    apEndDate: row.apEndDate,
    statutoryReason: row.statutoryReason,
    reviewStatus: row.reviewStatus as APPlacementSnapshot['reviewStatus'],
  }
}
