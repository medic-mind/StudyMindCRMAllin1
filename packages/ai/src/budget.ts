// AI cost guardrails. See CLAUDE.md Sections 18.3 and 32.
//
// At 80% of the daily cap we page finance + tech lead. At 100% we degrade:
// the structured/draft clients refuse to call the AI provider (Gemini or
// OpenAI — ADR 0028) and throw BusinessError('AI_BUDGET_EXCEEDED'). Caller
// decides how to fall back (skip, queue, downgrade to mini).
//
// This module currently uses an in-memory rolling counter. In production
// the counter must be backed by Redis (TODO: wire to Redis on Railway —
// `packages/core/cache/redis.ts` once it lands). The shape of the public
// API is stable across that swap.

export type AiTaskCategory =
  | 'call_outcome_classification'
  | 'call_summary_draft'
  | 'slack_summary'
  | 'merge_suggestion'
  | 'status_summary'
  | 'reply_draft'
  | 'intent_classifier'
  | 'churn_score'
  | 'transcription'
  | 'lead_classification'
  | 'product_classification'

export interface BudgetLimit {
  /** Daily cap in USD. */
  daily: number
  /** Monthly cap in USD. */
  monthly: number
}

// Starting numbers; tune in finops review. Each cap is sized to roughly 2x
// the steady-state cost for that task category at current volumes, leaving
// headroom for spikes without normalising into them.
export const BUDGETS: Readonly<Record<AiTaskCategory, BudgetLimit>> = {
  call_outcome_classification: { daily: 5, monthly: 100 },
  call_summary_draft: { daily: 4, monthly: 80 },
  slack_summary: { daily: 3, monthly: 60 },
  merge_suggestion: { daily: 2, monthly: 40 },
  status_summary: { daily: 8, monthly: 160 },
  reply_draft: { daily: 20, monthly: 400 },
  intent_classifier: { daily: 4, monthly: 80 },
  churn_score: { daily: 3, monthly: 60 },
  transcription: { daily: 10, monthly: 200 },
  lead_classification: { daily: 5, monthly: 100 },
  // Advisory pass over a payment description when rules find no catalogue
  // match. Low volume, mini-tier (ADR 0030).
  product_classification: { daily: 3, monthly: 60 },
}

interface UsageBucket {
  dayKey: string
  monthKey: string
  dailyUsd: number
  monthlyUsd: number
}

const buckets = new Map<AiTaskCategory, UsageBucket>()

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10) // YYYY-MM-DD
}

function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7) // YYYY-MM
}

function getBucket(task: AiTaskCategory, now = new Date()): UsageBucket {
  const day = todayKey(now)
  const month = monthKey(now)
  const existing = buckets.get(task)
  if (!existing) {
    const fresh: UsageBucket = { dayKey: day, monthKey: month, dailyUsd: 0, monthlyUsd: 0 }
    buckets.set(task, fresh)
    return fresh
  }
  if (existing.monthKey !== month) {
    existing.monthKey = month
    existing.dayKey = day
    existing.dailyUsd = 0
    existing.monthlyUsd = 0
  } else if (existing.dayKey !== day) {
    existing.dayKey = day
    existing.dailyUsd = 0
  }
  return existing
}

export interface RecordUsageInput {
  task: AiTaskCategory
  costUsd: number
}

export function recordUsage(input: RecordUsageInput): void {
  const bucket = getBucket(input.task)
  bucket.dailyUsd += input.costUsd
  bucket.monthlyUsd += input.costUsd
}

export type BudgetMode = 'normal' | 'page' | 'degraded'

export interface BudgetCheckResult {
  allowed: boolean
  remainingUsd: number
  mode: BudgetMode
}

export function checkBudget(task: AiTaskCategory): BudgetCheckResult {
  const limit = BUDGETS[task]
  const bucket = getBucket(task)
  const remaining = Math.max(0, limit.daily - bucket.dailyUsd)
  const utilisation = bucket.dailyUsd / limit.daily

  if (utilisation >= 1) {
    return { allowed: false, remainingUsd: 0, mode: 'degraded' }
  }
  if (utilisation >= 0.8) {
    return { allowed: true, remainingUsd: remaining, mode: 'page' }
  }
  return { allowed: true, remainingUsd: remaining, mode: 'normal' }
}

// Test-only reset.
export function __resetBudgetForTests(): void {
  buckets.clear()
}
