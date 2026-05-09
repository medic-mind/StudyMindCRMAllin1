// Production drift sampler. CLAUDE.md §18.3.
//
// On a small fraction of successful AI calls we persist a DriftSample for
// weekly reviewer triage. The sampler is intentionally small and fail-soft:
// if the db is not injected or persistence fails, the AI call still
// returns. Drift is a quality signal, not a critical path.
//
// PII: callers must redact before passing input/output (CLAUDE.md §35).
// The schema-level redaction here is a backstop only.

import { createId } from '@paralleldrive/cuid2'

import { logger } from '@studymind/core'

export interface DriftSampleDb {
  driftSample: {
    create: (args: {
      data: {
        id: string
        task: string
        model: string
        promptVersion: string
        input: unknown
        output: unknown
        costUsd: number
        sampledAt: Date
        reviewed: boolean
      }
    }) => Promise<unknown>
  }
}

let cachedDb: DriftSampleDb | null = null
let sampleRate = 0.01 // 1% — CLAUDE.md §18.3

export function setDriftSampleDb(db: DriftSampleDb | null): void {
  cachedDb = db
}

/** Test/operational override. Default is 0.01 (1%). */
export function setDriftSampleRate(rate: number): void {
  if (rate < 0 || rate > 1) throw new Error('drift sample rate must be in [0, 1]')
  sampleRate = rate
}

export interface SampleForDriftInput {
  task: string
  model: string
  promptVersion: string
  /** Caller is responsible for redaction. */
  input: unknown
  /** Caller is responsible for redaction. */
  output: unknown
  costUsd: number
}

/**
 * Probabilistically persist a DriftSample. Always resolves; never throws.
 * Designed to be invoked from inside the structured/draft clients after a
 * successful call without affecting the response.
 */
export async function sampleForDrift(input: SampleForDriftInput): Promise<void> {
  if (!cachedDb) return
  if (Math.random() >= sampleRate) return
  try {
    await cachedDb.driftSample.create({
      data: {
        id: createId(),
        task: input.task,
        model: input.model,
        promptVersion: input.promptVersion,
        input: input.input,
        output: input.output,
        costUsd: input.costUsd,
        sampledAt: new Date(),
        reviewed: false,
      },
    })
  } catch (err) {
    logger.warn(
      { task: input.task, err: err instanceof Error ? err.message : String(err) },
      'ai.drift.sample_failed',
    )
  }
}
