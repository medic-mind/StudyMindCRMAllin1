// Field-level decryption placeholder. CLAUDE.md §21.1.
//
// The production implementation is envelope encryption with AWS KMS:
//   1. RBAC + per-row attribute check (caller must have the right role).
//   2. AuditLogEntry write BEFORE the decryption call.
//   3. KMS Decrypt with the AAD; mismatch fails closed.
//   4. Return plaintext to the caller; never log it.
//
// For Slice 5 we ship the function shape and a deterministic dev stub so
// callers (Trengo per-agent tokens, future safeguarding fields) can be
// written and tested without the AWS SDK landing first. The real
// implementation will replace this body in a follow-up PR with the KMS
// dependency added behind an ADR.

import { BusinessError } from '../errors'

export interface EnvelopeCiphertext {
  ciphertext: Uint8Array
  iv: Uint8Array
  dekCiphertext: Uint8Array
  aad: Uint8Array
  keyVersion: number
}

export interface DecryptContext {
  /** Caller identity for the audit entry. */
  actorId: string | null
  /** Why the decryption is happening — required by AAD policy. */
  purpose: string
  /** Trace correlation id. */
  requestId?: string
}

/**
 * Decrypt an envelope-encrypted field. Returns the plaintext as a UTF-8
 * string. Fails closed on any verification failure.
 *
 * This is the seam the production KMS implementation will replace. The
 * stub interprets `ciphertext` as already-plaintext UTF-8 bytes when
 * `keyVersion === 0`, which is what the development seed produces. Any
 * non-zero keyVersion routes through KMS in production.
 */
export async function decryptField(
  envelope: EnvelopeCiphertext,
  ctx: DecryptContext,
): Promise<string> {
  if (!ctx.purpose || ctx.purpose.trim().length === 0) {
    // Empty purpose is a hard fail — see CLAUDE.md §41.3 invariant.
    throw new BusinessError('CONTACT_RESTRICTED', 'decryptField requires a non-empty purpose')
  }
  if (envelope.keyVersion === 0) {
    // Dev / seed mode: ciphertext is plaintext UTF-8 bytes.
    return Buffer.from(envelope.ciphertext).toString('utf8')
  }
  // Production path is not in this slice; refuse to silently downgrade.
  throw new BusinessError(
    'NOT_IMPLEMENTED',
    'KMS decryption is not yet wired; only keyVersion=0 stubs are supported in dev.',
  )
}
