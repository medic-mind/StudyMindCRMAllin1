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
