// Typed business errors. Prefer over `throw new Error('...')` in domain code.

export type BusinessErrorCode =
  | 'FAMILY_HAS_OPEN_BALANCE'
  | 'CONTACT_RESTRICTED'
  | 'INVALID_STATE_TRANSITION'
  | 'TOKEN_EXPIRED'
  | 'NOT_IMPLEMENTED'
  | 'AI_OUTPUT_INVALID'
  | 'AI_BUDGET_EXCEEDED'
  | 'CONTACT_MERGE_SELF'
  | 'CONTACT_NOT_FOUND'
  | 'CONTACT_MERGE_RESTRICTED_DSL_CONFLICT'
  | 'OUTBOUND_HOST_BLOCKED'
  | 'AUTH_PIVOT_PENDING'
  | 'PASSWORD_TOO_WEAK'
  | 'ACCOUNT_LOCKED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'TOKEN_EXPIRED_OR_USED'
  | 'LAST_SUPER_ADMIN'
  | 'LAST_CEO'
  | 'PIPELINE_STAGE_HAS_FAMILIES'
  | 'PIPELINE_STAGE_NAME_TAKEN'
  | 'PIPELINE_STAGE_NOT_FOUND'
  | 'PIPELINE_STAGE_ARCHIVED'
  // ADR 0018: multi-board cards.
  | 'BOARD_NOT_FOUND'
  | 'BOARD_ARCHIVED'
  | 'BOARD_NAME_TAKEN'
  | 'BOARD_IS_DEFAULT'
  | 'CARD_NOT_FOUND'
  | 'COMMENT_EMPTY'
  | 'CALL_SUMMARY_EMPTY'
  | 'CALL_SUMMARY_NOT_FOUND'
  | 'LABEL_NOT_FOUND'
  | 'LABEL_NAME_TAKEN'
  | 'LABEL_IN_USE'
  | 'SUBJECT_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  // Forwarding ("Forward to <team>" quick action — packages/core/src/forwarding).
  | 'FORWARDING_RULE_NOT_FOUND'
  | 'FORWARDING_RULE_ARCHIVED'
  // Board quick actions (per-board configurable buttons that move a card +
  // add a comment in one click).
  | 'QUICK_ACTION_NOT_FOUND'
  // Card sub-tasks (Todoist-style checklist on a card).
  | 'SUBTASK_EMPTY'
  | 'SUBTASK_TOO_LONG'
  | 'SUBTASK_NOT_FOUND'
  // ADR 0020 Phase 6e: assigning a Trengo conversation to a CRM user.
  | 'UNKNOWN_USER'
  | 'NO_TRENGO_IDENTITY'
  | 'UNKNOWN'

export class BusinessError extends Error {
  public readonly code: BusinessErrorCode
  public readonly details: Record<string, unknown> | undefined

  constructor(code: BusinessErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code)
    this.name = 'BusinessError'
    this.code = code
    this.details = details
  }
}
