// TOTP helpers for MFA. CLAUDE.md §20 (MFA mandatory for privileged roles)
// and ADR 0010. All TOTP cryptography goes through `otplib`; this module
// configures the algorithm, the verification window, and the recovery-code
// shape so the rest of the app does not have to care.
//
// Recovery codes: 10 codes of 10 chars each, drawn from a 32-char alphabet
// that excludes ambiguous glyphs (0/O, 1/I/L). They are sha256-hashed at
// rest; the plaintext is shown to the user exactly once at enrolment.

import { createHash, randomBytes } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'
import { authenticator } from 'otplib'
import type { Prisma, PrismaClient } from '@prisma/client'

// 30-second step (RFC 6238 default) with a 1-step skew so a code that
// rolled over mid-request is still accepted. Window is symmetric.
authenticator.options = { step: 30, window: 1 }

const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L
const RECOVERY_CODE_LENGTH = 10
const RECOVERY_CODE_COUNT = 10

export interface GeneratedSecret {
  base32: string
  otpauthUrl(email: string, issuer: string): string
}

/**
 * Generate a fresh TOTP secret. The base32 string is what we encrypt and
 * persist; `otpauthUrl` is what we render as a QR for the user's
 * Authenticator app.
 */
export function generateTotpSecret(): GeneratedSecret {
  const base32 = authenticator.generateSecret()
  return {
    base32,
    otpauthUrl(email, issuer) {
      return authenticator.keyuri(email, issuer, base32)
    },
  }
}

/**
 * Verify a 6-digit TOTP code against the user's secret. Returns true only
 * if the code is exactly 6 digits and validates within the configured skew
 * window. We deliberately do NOT consume the code here — TOTP is naturally
 * single-use within a 30 s window because the next request will fall into
 * the next step. Replays inside the same step are accepted by design (the
 * spec); replay protection at the session layer is sufficient.
 */
export function verifyTotpCode({
  secret,
  code,
}: {
  secret: string
  code: string
}): boolean {
  if (typeof code !== 'string') return false
  const trimmed = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(trimmed)) return false
  try {
    return authenticator.check(trimmed, secret)
  } catch {
    return false
  }
}

/** True if `code` is shaped like a recovery code (not a 6-digit TOTP). */
export function isRecoveryCodeShaped(code: string): boolean {
  const cleaned = normaliseRecoveryCode(code)
  return cleaned.length === RECOVERY_CODE_LENGTH && /^[A-Z2-9]+$/.test(cleaned)
}

function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}

function hashRecoveryCode(plain: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(plain)).digest('hex')
}

export interface RecoveryCodeBundle {
  plain: string[]
  hashes: string[]
}

/**
 * Generate `RECOVERY_CODE_COUNT` recovery codes. Returns plaintext (for
 * one-time display) and sha256 hashes (for persistence). The caller must
 * never persist `plain`.
 */
export function generateRecoveryCodes(): RecoveryCodeBundle {
  const plain: string[] = []
  const hashes: string[] = []
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const code = drawRecoveryCode()
    plain.push(code)
    hashes.push(hashRecoveryCode(code))
  }
  return { plain, hashes }
}

function drawRecoveryCode(): string {
  // Rejection-sample bytes to avoid modulo bias on the 31-char alphabet.
  const out: string[] = []
  while (out.length < RECOVERY_CODE_LENGTH) {
    const buf = randomBytes(RECOVERY_CODE_LENGTH * 2)
    for (let i = 0; i < buf.length && out.length < RECOVERY_CODE_LENGTH; i += 1) {
      const b = buf[i]!
      if (b < 248) {
        // 248 = 8 * 31 — largest multiple of alphabet length below 256
        const ch = RECOVERY_CODE_ALPHABET[b % RECOVERY_CODE_ALPHABET.length]!
        out.push(ch)
      }
    }
  }
  return out.join('')
}

export type DbReader = PrismaClient | Prisma.TransactionClient

/**
 * Verify a recovery code: it must hash-match an unused row for the user.
 * On success the row is marked `usedAt = now()` in the same transaction so
 * a concurrent replay loses the race. Returns true if a code was consumed.
 */
export async function verifyRecoveryCode({
  db,
  userId,
  code,
}: {
  db: DbReader
  userId: string
  code: string
}): Promise<boolean> {
  if (!isRecoveryCodeShaped(code)) return false
  const codeHash = hashRecoveryCode(code)
  const consumed = await db.totpRecoveryCode.updateMany({
    where: { userId, codeHash, usedAt: null },
    data: { usedAt: new Date() },
  })
  return consumed.count === 1
}

export interface InsertRecoveryCodeRow {
  id: string
  userId: string
  codeHash: string
}

/**
 * Build the rows to insert for a fresh recovery-code bundle. Pulled into a
 * helper so the setup page can run the insert in the same transaction as
 * the User update.
 */
export function buildRecoveryCodeRows(
  userId: string,
  hashes: string[],
): InsertRecoveryCodeRow[] {
  return hashes.map((codeHash) => ({ id: createId(), userId, codeHash }))
}

export const TOTP_TEST_HELPERS = {
  hashRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY_CODE_LENGTH,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_ALPHABET,
}
