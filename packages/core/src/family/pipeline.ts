// Move a Family to a different PipelineStage. ADR 0015. CLAUDE.md §6.4.
//
// The writer is the only path that touches `Family.stageId`. It:
//   1. Loads the family and the target stage (rejects archived stages).
//   2. Updates `stageId` and best-effort mirrors the legacy `state` column.
//   3. Writes a `family_pipeline_moved` Interaction with the from/to ids.
//   4. Records the action in the audit log via the injected helper.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import type { FamilyState } from './types'
import { mirrorStateForStage } from '../pipeline/stages'

export interface MoveFamilyInput {
  familyId: string
  toStageId: string
  actorId: string
  requestId: string
}

export interface MoveFamilyResult {
  familyId: string
  fromStageId: string | null
  toStageId: string
  fromState: FamilyState | null
  toState: FamilyState | null
}

/**
 * Move a family to a different pipeline stage. Atomic: family update,
 * interaction row, and audit row land in one Postgres transaction.
 *
 * The legacy `Family.state` enum is updated when the target stage's name
 * maps to a known FamilyState (`mirrorStateForStage`). When it does not
 * map (custom operator-defined stage), `state` is left untouched and the
 * column becomes uninformative for that family — consumers that still
 * read `state` (at-risk derivation, churn-score, reconciliation) keep
 * working but reflect the family's last legacy state.
 */
export async function moveFamily(
  db: PrismaClient,
  input: MoveFamilyInput,
): Promise<MoveFamilyResult> {
  const family = await db.family.findFirst({
    where: { id: input.familyId, deletedAt: null },
    select: { id: true, stageId: true, state: true },
  })
  if (!family) {
    throw new BusinessError(
      'CONTACT_NOT_FOUND',
      'Family not found',
      { familyId: input.familyId },
    )
  }

  const stage = await db.pipelineStage.findUnique({
    where: { id: input.toStageId },
    select: { id: true, name: true, archivedAt: true },
  })
  if (!stage) {
    throw new BusinessError(
      'PIPELINE_STAGE_NOT_FOUND',
      'Target pipeline stage not found',
      { stageId: input.toStageId },
    )
  }
  if (stage.archivedAt !== null) {
    throw new BusinessError(
      'PIPELINE_STAGE_ARCHIVED',
      'Cannot move a family onto an archived stage',
      { stageId: stage.id },
    )
  }

  const fromStageId = family.stageId
  const fromState = family.state as FamilyState | null
  const mirroredState = mirrorStateForStage(stage.name)
  const toState: FamilyState | null = mirroredState ?? fromState

  return db.$transaction(async (tx) => {
    await tx.family.update({
      where: { id: family.id },
      data: {
        stageId: stage.id,
        // Only touch `state` when the new stage name maps to a legacy enum
        // value. Custom-named stages leave the column alone so we never
        // write a meaningless value.
        ...(mirroredState ? { state: mirroredState } : {}),
        updatedById: input.actorId,
      },
    })

    await tx.interaction.create({
      data: {
        id: createId(),
        type: 'family_pipeline_moved',
        familyId: family.id,
        occurredAt: new Date(),
        summary: `Pipeline: → ${stage.name}`,
        payload: {
          fromStageId,
          toStageId: stage.id,
          fromState,
          toState,
        },
        createdById: input.actorId,
        updatedById: input.actorId,
      },
    })

    await writeAuditLogEntry(tx, {
      actorId: input.actorId,
      requestId: input.requestId,
      action: 'family.pipeline_moved',
      target: { type: 'Family', id: family.id },
      before: { stageId: fromStageId, state: fromState },
      after: { stageId: stage.id, state: toState, stageName: stage.name },
    })

    return {
      familyId: family.id,
      fromStageId,
      toStageId: stage.id,
      fromState,
      toState,
    }
  })
}
