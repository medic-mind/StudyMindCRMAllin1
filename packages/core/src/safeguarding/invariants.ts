// Safeguarding invariants. Pure; CLAUDE.md §41.3.

export interface InvariantOk {
  ok: true
}
export interface InvariantFail {
  ok: false
  code: string
  message: string
}
export type InvariantResult = InvariantOk | InvariantFail

/**
 * §41.3: a SafeguardingFlag at `restricted_access` requires a named DSL
 * assignee. No assignee, no save.
 */
export function checkRestrictedAccessHasDsl(input: {
  state: string
  dslUserId: string | null
}): InvariantResult {
  if (input.state === 'restricted_access' && !input.dslUserId) {
    return {
      ok: false,
      code: 'RESTRICTED_REQUIRES_DSL',
      message: 'restricted_access flag requires a named DSL assignee',
    }
  }
  return { ok: true }
}

/**
 * §41.3: decryption of an EncryptedField requires a non-empty `purpose`
 * string in the audit entry.
 */
export function checkDecryptHasPurpose(purpose: string | null | undefined): InvariantResult {
  if (!purpose || purpose.trim().length === 0) {
    return {
      ok: false,
      code: 'DECRYPT_REQUIRES_PURPOSE',
      message: 'A non-empty purpose is required to decrypt a safeguarding field',
    }
  }
  return { ok: true }
}

/**
 * §41.3: a Contact cannot be hard-deleted while any SafeguardingFlag is
 * active. Soft delete then DSL review is the only path.
 */
export function checkNoHardDeleteWithActiveFlag(input: {
  hardDelete: boolean
  hasActiveFlag: boolean
}): InvariantResult {
  if (input.hardDelete && input.hasActiveFlag) {
    return {
      ok: false,
      code: 'HARD_DELETE_BLOCKED_BY_FLAG',
      message: 'Cannot hard-delete a Contact with an active safeguarding flag',
    }
  }
  return { ok: true }
}
