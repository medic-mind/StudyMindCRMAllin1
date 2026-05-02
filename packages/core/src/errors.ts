// Typed business errors. Prefer over `throw new Error('...')` in domain code.

export type BusinessErrorCode =
  | 'FAMILY_HAS_OPEN_BALANCE'
  | 'CONTACT_RESTRICTED'
  | 'INVALID_STATE_TRANSITION'
  | 'TOKEN_EXPIRED'
  | 'NOT_IMPLEMENTED'
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
