// AI cost guardrails. See CLAUDE.md Section 18.3 and Section 32.

export type AiTaskCategory =
  | 'call_outcome_classification'
  | 'slack_summary'
  | 'merge_suggestion'
  | 'status_summary'
  | 'reply_draft'
  | 'tender_draft'
  | 'intent_classifier'
  | 'churn_score'
  | 'transcription'

// Daily caps in GBP minor units (pence).
export const DAILY_CAPS_MINOR: Readonly<Record<AiTaskCategory, number>> = {
  call_outcome_classification: 200_00,
  slack_summary: 100_00,
  merge_suggestion: 50_00,
  status_summary: 300_00,
  reply_draft: 500_00,
  tender_draft: 200_00,
  intent_classifier: 100_00,
  churn_score: 100_00,
  transcription: 400_00,
}

export interface BudgetCheckResult {
  allowed: boolean
  utilisation: number
  reason?: string
}

export async function checkBudget(_task: AiTaskCategory): Promise<BudgetCheckResult> {
  throw new Error('not implemented')
}
