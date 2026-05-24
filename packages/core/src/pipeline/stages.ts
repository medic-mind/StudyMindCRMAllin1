// Pipeline stage domain helpers. Pure functions only.
// ADR 0015. CLAUDE.md §6.4.

import { BusinessError } from '../errors'
import type { FamilyState } from '../family/types'

export interface PipelineStageRecord {
  id: string
  name: string
  position: number
  color: string
  isClosed: boolean
  archivedAt: Date | null
}

/**
 * Throws if `position` collides with any active stage's position. Active
 * stages are those with `archivedAt === null`. Archived stages keep their
 * old position and never count toward the uniqueness check (mirrors the
 * partial unique index in the migration).
 *
 * `ignoreStageId` lets the caller exclude the stage currently being
 * updated, so renaming a stage to the same position it already holds is a
 * no-op rather than a self-collision.
 */
export function assertUniquePosition(
  stages: ReadonlyArray<PipelineStageRecord>,
  position: number,
  ignoreStageId?: string,
): void {
  if (!Number.isInteger(position) || position < 1) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      'Stage position must be a positive integer',
      { position },
    )
  }
  const conflict = stages.find(
    (s) =>
      s.archivedAt === null &&
      s.position === position &&
      s.id !== ignoreStageId,
  )
  if (conflict) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      'Another active stage already occupies that position',
      { position, conflictId: conflict.id },
    )
  }
}

/**
 * Next available position at the end of the active list. Used when an
 * operator creates a new stage without specifying a position.
 */
export function nextPosition(
  stages: ReadonlyArray<PipelineStageRecord>,
): number {
  const active = stages.filter((s) => s.archivedAt === null)
  if (active.length === 0) return 1
  return Math.max(...active.map((s) => s.position)) + 1
}

export interface CanArchiveInput {
  stage: PipelineStageRecord
  familiesOnStage: number
  /**
   * Required when `familiesOnStage > 0`. Must be the id of another active
   * stage (not the one being archived).
   */
  reassignToStageId?: string | null
  /** All active stages, used to validate `reassignToStageId`. */
  activeStages: ReadonlyArray<PipelineStageRecord>
}

/**
 * Whether the stage may be archived. Throws BusinessError with a typed
 * code on failure so the caller can map cleanly to a tRPC error.
 *
 * - If the stage already has `archivedAt` set, throws PIPELINE_STAGE_ARCHIVED.
 * - If families remain on the stage and no `reassignToStageId` is given,
 *   throws PIPELINE_STAGE_HAS_FAMILIES — the caller MUST resolve this
 *   before archival.
 * - If `reassignToStageId` is the same as the archived stage's id, or is
 *   not an active stage, throws INVALID_STATE_TRANSITION.
 */
export function canArchiveStage(input: CanArchiveInput): void {
  const { stage, familiesOnStage, reassignToStageId, activeStages } = input
  if (stage.archivedAt !== null) {
    throw new BusinessError(
      'PIPELINE_STAGE_ARCHIVED',
      'Stage is already archived',
      { stageId: stage.id },
    )
  }
  if (familiesOnStage > 0) {
    if (!reassignToStageId) {
      throw new BusinessError(
        'PIPELINE_STAGE_HAS_FAMILIES',
        `Cannot archive: ${familiesOnStage} families are still on this stage`,
        { stageId: stage.id, familiesOnStage },
      )
    }
    if (reassignToStageId === stage.id) {
      throw new BusinessError(
        'INVALID_STATE_TRANSITION',
        'Cannot reassign families to the stage being archived',
        { stageId: stage.id },
      )
    }
    const target = activeStages.find(
      (s) => s.id === reassignToStageId && s.archivedAt === null,
    )
    if (!target) {
      throw new BusinessError(
        'PIPELINE_STAGE_NOT_FOUND',
        'Reassignment target stage is not active',
        { reassignToStageId },
      )
    }
  }
}

/**
 * Best-effort mirror from a PipelineStage name back to the legacy
 * FamilyState enum. Used by `moveFamily` to keep the deprecated
 * `Family.state` column meaningful for consumers that still read it
 * (at-risk derivation, churn-score job, reconciliation engine,
 * notification labels). Returns null when no enum value matches — in
 * that case the caller leaves `state` unchanged.
 *
 * Matching is case-insensitive and tolerates the two display variants for
 * `at_risk` (`At risk` and `At Risk`).
 */
export function mirrorStateForStage(stageName: string): FamilyState | null {
  const normalised = stageName.trim().toLowerCase().replace(/\s+/g, '_')
  switch (normalised) {
    case 'lead':
      return 'lead'
    case 'trial':
      return 'trial'
    case 'active':
      return 'active'
    case 'at_risk':
      return 'at_risk'
    case 'churned':
      return 'churned'
    default:
      return null
  }
}
