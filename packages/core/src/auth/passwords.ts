// Password and token primitives for self-hosted auth (ADR 0010).
//
// All hashing here is bcrypt cost 12 for passwords; tokens are sha256 hashed
// before persistence so a database leak never reveals plaintext credentials.
// CLAUDE.md §44.2 (controls), §21.1 (encryption posture).

import { createHash, randomBytes } from 'node:crypto'

import bcrypt from 'bcryptjs'

import { BusinessError } from '../errors'

const BCRYPT_COST = 12
const MIN_PASSWORD_LENGTH = 12

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

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
