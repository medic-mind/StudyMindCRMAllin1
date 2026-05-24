// Churn risk scoring prompt. CLAUDE.md §18, §17.1 (nightly 03:00 UTC after
// finance/reconcile.completed). Aggregates per-Family signals into a score
// in [0, 1], with 3–5 short driver labels and a brief rationale.

import { z } from 'zod'

import { SAFEGUARDING_GUARDRAIL } from './style/safeguarding'

export const VERSION = '2026-05-09.1'

export const churnScoreSchema = z.object({
  score: z.number().min(0).max(1),
  drivers: z.array(z.string().min(1).max(80)).min(3).max(5),
  rationale: z.string().min(1).max(400),
})

export type ChurnScoreOutput = z.infer<typeof churnScoreSchema>

/** Aggregated, pre-computed signals — no PII, no free-form messages. */
export interface ChurnSignals {
  /** Days since the last Interaction on the Family timeline. */
  daysSinceLastInteraction: number
  /** Count of failed Stripe charges or GoCardless DDs in the last 60 days. */
  paymentFailuresLast60d: number
  /** Count of no_show or cancelled BookingSession in the last 60 days. */
  missedSessionsLast60d: number
  /** Mean sentiment score from inbound messages, in [-1, 1]. Null when no signal. */
  sentimentMean: number | null
  /** Family lifecycle state — lead/trial/active/at_risk/churned. */
  state: string
  /** Number of unresolved reconciliation discrepancies. */
  openDiscrepancies: number
}

const SYSTEM = `
You score a StudyMind Family's churn risk from aggregated signals. Return
JSON matching the schema and nothing else.

${SAFEGUARDING_GUARDRAIL}

Definitions:
- score: a number in [0, 1] estimating the probability that this Family
  churns in the next 30 days. 0.0 means very unlikely; 1.0 means imminent.
- drivers: 3 to 5 short labels (each ≤ 80 chars) naming the main signals.
  Use plain English: "Two payment failures in 30 days",
  "No interaction in 21 days", "Negative sentiment trend".
- rationale: ≤ 400 chars. One paragraph, factual, no marketing tone.

Calibration:
- Strong negatives (multiple recent payment failures, long silence,
  unresolved discrepancies, negative sentiment) push above 0.6.
- Active engagement, recent successful payments, and positive sentiment
  pull score down.
`.trim()

export interface ChurnScorePromptInput {
  signals: ChurnSignals
}

export function buildChurnScorePrompt(
  input: ChurnScorePromptInput,
): { system: string; user: string; promptVersion: string } {
  // Signals are already aggregated numbers — no sanitisation needed.
  const user = `Signals:\n${JSON.stringify(input.signals, null, 2)}`
  return { system: SYSTEM, user, promptVersion: VERSION }
}

/** Threshold at which a retention task is auto-created. CLAUDE.md §18. */
export const CHURN_TASK_THRESHOLD = 0.7
