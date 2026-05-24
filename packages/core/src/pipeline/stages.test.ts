// PipelineStage helper tests. ADR 0015.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'

import {
  assertUniquePosition,
  canArchiveStage,
  mirrorStateForStage,
  nextPosition,
  type PipelineStageRecord,
} from './stages'

function stage(p: Partial<PipelineStageRecord>): PipelineStageRecord {
  return {
    id: p.id ?? 'stg_1',
    name: p.name ?? 'Lead',
    position: p.position ?? 1,
    color: p.color ?? 'blue-500',
    isClosed: p.isClosed ?? false,
    archivedAt: p.archivedAt ?? null,
  }
}

describe('assertUniquePosition', () => {
  it('passes when the position is free among active stages', () => {
    const stages = [stage({ id: 'a', position: 1 }), stage({ id: 'b', position: 2 })]
    expect(() => assertUniquePosition(stages, 3)).not.toThrow()
  })

  it('throws when another active stage holds the position', () => {
    const stages = [stage({ id: 'a', position: 1 })]
    expect(() => assertUniquePosition(stages, 1)).toThrow(BusinessError)
  })

  it('ignores the stage being updated', () => {
    const stages = [stage({ id: 'a', position: 1 })]
    expect(() => assertUniquePosition(stages, 1, 'a')).not.toThrow()
  })

  it('ignores archived stages with the same position', () => {
    const stages = [stage({ id: 'a', position: 1, archivedAt: new Date() })]
    expect(() => assertUniquePosition(stages, 1)).not.toThrow()
  })

  it('rejects non-positive positions', () => {
    expect(() => assertUniquePosition([], 0)).toThrow(BusinessError)
    expect(() => assertUniquePosition([], -1)).toThrow(BusinessError)
    expect(() => assertUniquePosition([], 1.5)).toThrow(BusinessError)
  })
})

describe('nextPosition', () => {
  it('returns 1 on empty input', () => {
    expect(nextPosition([])).toBe(1)
  })

  it('returns max active position + 1', () => {
    const stages = [
      stage({ id: 'a', position: 1 }),
      stage({ id: 'b', position: 4 }),
      stage({ id: 'c', position: 2 }),
    ]
    expect(nextPosition(stages)).toBe(5)
  })

  it('ignores archived stages', () => {
    const stages = [
      stage({ id: 'a', position: 1 }),
      stage({ id: 'b', position: 99, archivedAt: new Date() }),
    ]
    expect(nextPosition(stages)).toBe(2)
  })
})

describe('canArchiveStage', () => {
  const active: PipelineStageRecord[] = [
    stage({ id: 'a', position: 1 }),
    stage({ id: 'b', position: 2 }),
  ]
  const stageA = active[0]!
  const stageB = active[1]!
  void stageB

  it('allows archiving an empty stage', () => {
    expect(() =>
      canArchiveStage({
        stage: stageA,
        familiesOnStage: 0,
        activeStages: active,
      }),
    ).not.toThrow()
  })

  function expectCode(fn: () => unknown, code: string) {
    try {
      fn()
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessError)
      expect((err as BusinessError).code).toBe(code)
    }
  }

  it('rejects when families remain and no reassign target is given', () => {
    expectCode(
      () =>
        canArchiveStage({
          stage: stageA,
          familiesOnStage: 3,
          activeStages: active,
        }),
      'PIPELINE_STAGE_HAS_FAMILIES',
    )
  })

  it('allows archiving when a valid reassign target is provided', () => {
    expect(() =>
      canArchiveStage({
        stage: stageA,
        familiesOnStage: 3,
        reassignToStageId: 'b',
        activeStages: active,
      }),
    ).not.toThrow()
  })

  it('rejects reassigning to the stage being archived', () => {
    expect(() =>
      canArchiveStage({
        stage: stageA,
        familiesOnStage: 1,
        reassignToStageId: 'a',
        activeStages: active,
      }),
    ).toThrow(BusinessError)
  })

  it('rejects an unknown reassign target', () => {
    expectCode(
      () =>
        canArchiveStage({
          stage: stageA,
          familiesOnStage: 1,
          reassignToStageId: 'nope',
          activeStages: active,
        }),
      'PIPELINE_STAGE_NOT_FOUND',
    )
  })

  it('rejects re-archiving an already-archived stage', () => {
    expectCode(
      () =>
        canArchiveStage({
          stage: stage({ id: 'x', archivedAt: new Date() }),
          familiesOnStage: 0,
          activeStages: active,
        }),
      'PIPELINE_STAGE_ARCHIVED',
    )
  })
})

describe('mirrorStateForStage', () => {
  it.each([
    ['Lead', 'lead'],
    ['Trial', 'trial'],
    ['Active', 'active'],
    ['At risk', 'at_risk'],
    ['At Risk', 'at_risk'],
    ['Churned', 'churned'],
    ['  CHURNED  ', 'churned'],
  ])('maps %s -> %s', (name, expected) => {
    expect(mirrorStateForStage(name)).toBe(expected)
  })

  it('returns null for a custom stage name', () => {
    expect(mirrorStateForStage('Discovery')).toBeNull()
    expect(mirrorStateForStage('Renewal pending')).toBeNull()
  })
})
