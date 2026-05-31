// Password and token primitives for self-hosted auth (ADR 0010).
//
// All hashing here is bcrypt cost 12 for passwords; tokens are sha256 hashed
// before persistence so a database leak never reveals plaintext credentials.
// CLAUDE.md §44.2 (controls), §21.1 (encryption posture).

import { createHash, randomBytes, randomInt } from 'node:crypto'

import bcrypt from 'bcryptjs'

import { BusinessError } from '../errors'

const BCRYPT_COST = 12
const MIN_PASSWORD_LENGTH = 12

// Character classes for generated temporary passwords. We deliberately drop
// 0/O/1/l/I so a human can transcribe the password from the welcome PDF
// without ambiguity (ADR 0021).
const TEMP_PW_LOWER = 'abcdefghijkmnpqrstuvwxyz'
const TEMP_PW_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const TEMP_PW_DIGIT = '23456789'
const TEMP_PW_SYMBOL = '!@#$%^&*?-_+='
const TEMP_PW_ALL = TEMP_PW_LOWER + TEMP_PW_UPPER + TEMP_PW_DIGIT + TEMP_PW_SYMBOL
const TEMP_PW_LENGTH = 16

/** Bcrypt-hash a plaintext password at cost 12. */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST)
}

/** Constant-time verify a plaintext password against a stored bcrypt hash. */
export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false
  return bcrypt.compare(plaintext, hash)
}

/**
 * Generate a 32-byte cryptographically secure random token, encoded as
 * url-safe base64 with no padding. Used for session, email verification,
 * password reset, and OAuth state tokens.
 */
export function generateToken(): string {
  return base64Url(randomBytes(32))
}

/**
 * SHA-256 hash a token, returning lowercase hex. Tokens are stored as their
 * hash; the plaintext is only ever held in the cookie / verification email
 * and never persisted server-side.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Throws BusinessError('PASSWORD_TOO_WEAK') if the password is shorter than
 * 12 characters or fails to meet at least 3 of: lowercase, uppercase, digit,
 * symbol. We keep this deliberately simple — for richer rules use a library.
 */
export function assertStrongPassword(plaintext: string): void {
  if (typeof plaintext !== 'string' || plaintext.length < MIN_PASSWORD_LENGTH) {
    throw new BusinessError('PASSWORD_TOO_WEAK', 'Password must be at least 12 characters.')
  }
  let classes = 0
  if (/[a-z]/.test(plaintext)) classes += 1
  if (/[A-Z]/.test(plaintext)) classes += 1
  if (/[0-9]/.test(plaintext)) classes += 1
  if (/[^A-Za-z0-9]/.test(plaintext)) classes += 1
  if (classes < 3) {
    throw new BusinessError(
      'PASSWORD_TOO_WEAK',
      'Password must include at least 3 of: lowercase, uppercase, digit, symbol.',
    )
  }
}

/**
 * Generate a strong, human-transcribable temporary password for an
 * admin-created account or an admin-triggered reset (ADR 0021). The result
 * always satisfies `assertStrongPassword` (16 chars, one of each class) and is
 * shown to the new user once — in the welcome email and PDF — then must be
 * changed on first login (the `mustResetPassword` gate).
 */
export function generateTemporaryPassword(): string {
  // Seed one character from each class so the policy always passes, fill to
  // length from the union, then Fisher–Yates shuffle with unbiased crypto
  // indices so the guaranteed characters are not in fixed positions.
  const chars: string[] = [
    pickChar(TEMP_PW_LOWER),
    pickChar(TEMP_PW_UPPER),
    pickChar(TEMP_PW_DIGIT),
    pickChar(TEMP_PW_SYMBOL),
  ]
  while (chars.length < TEMP_PW_LENGTH) {
    chars.push(pickChar(TEMP_PW_ALL))
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    const tmp = chars[i] as string
    chars[i] = chars[j] as string
    chars[j] = tmp
  }
  return chars.join('')
}

function pickChar(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)] as string
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
