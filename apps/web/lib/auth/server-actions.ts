// Server actions for the unauthenticated auth pages: sign-up, verify, forgot,
// reset, resend verification. ADR 0010, CLAUDE.md §44.2.
//
// These run in the Node runtime (they touch Prisma + bcrypt + KMS-adjacent
// helpers). Each action is rate-limited per-email and per-IP (5 attempts /
// 15 min) using the same sliding-window primitive as the tRPC middleware,
// scoped differently because we don't have a userId at sign-up time.
//
// Enumeration safety: forgot/resend always return the same generic response
// regardless of whether the account exists. Sign-up returns a generic error
// when the email is already registered.

'use server'

import { createId } from '@paralleldrive/cuid2'
import { headers } from 'next/headers'

import { writeAuditLogEntry } from '@studymind/audit'
import {
  assertStrongPassword,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '@studymind/core/auth/passwords'
import { BusinessError } from '@studymind/core/errors'
import { logger } from '@studymind/core/logger'
import { db } from '@studymind/db'
import { sendEmail } from '@studymind/integration-resend'

import { authRateLimit } from './rate-limit-handler'

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
const RESET_TTL_MS = 60 * 60 * 1000

export interface ActionOk {
  ok: true
  message?: string
}

export interface ActionError {
  ok: false
  error: string
}

export type ActionResult = ActionOk | ActionError

function appUrl(): string {
  return (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

async function clientIp(): Promise<string> {
  const h = await headers()
  return (h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown') || 'unknown'
}

async function requireRateLimit(scope: string, key: string): Promise<boolean> {
  return authRateLimit({ scope, key })
}

/* -------------------------------------------------------------------------- */
/* sign-up                                                                     */
/* -------------------------------------------------------------------------- */

export interface SignUpInput {
  email: string
  password: string
  name: string
}

/**
 * Public self-service sign-up is DISABLED (ADR 0021). Accounts are created
 * only by a CEO or Senior Manager through `admin.users.create`, which issues a
 * temporary password and a welcome email + PDF. This stub remains so the
 * contract is explicit and a regression test can assert sign-up stays closed.
 */
export async function signUp(_input: SignUpInput): Promise<ActionResult> {
  return {
    ok: false,
    error:
      'Self-service sign-up is disabled. Please ask a CEO or Senior Manager to create your account.',
  }
}

/* -------------------------------------------------------------------------- */
/* verify email                                                                */
/* -------------------------------------------------------------------------- */

export interface VerifyResult {
  ok: boolean
  /** When false, surface a generic error and a "resend" form. */
  error?: 'invalid' | 'expired'
}

export async function verifyEmail(rawToken: string): Promise<VerifyResult> {
  if (!rawToken) return { ok: false, error: 'invalid' }
  const tokenHash = hashToken(rawToken)
  const row = await db.emailVerificationToken.findUnique({ where: { tokenHash } })
  if (!row || row.usedAt) return { ok: false, error: 'invalid' }
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: 'expired' }

  const now = new Date()
  await db.$transaction([
    db.emailVerificationToken.update({
      where: { id: row.id },
      data: { usedAt: now },
    }),
    db.user.update({
      where: { id: row.userId },
      data: { emailVerifiedAt: now },
    }),
  ])

  await writeAuditLogEntry(db, {
    actorId: row.userId,
    action: 'auth.email_verified',
    target: { type: 'User', id: row.userId },
  })

  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/* resend verification                                                         */
/* -------------------------------------------------------------------------- */

export async function resendVerification(emailRaw: string): Promise<ActionResult> {
  const email = emailRaw.trim().toLowerCase()
  if (!email) return { ok: false, error: 'Email is required.' }

  const ip = await clientIp()
  const okIp = await requireRateLimit('resend:ip', ip)
  const okEmail = await requireRateLimit('resend:email', email)
  if (!okIp || !okEmail) {
    return { ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' }
  }

  const user = await db.user.findUnique({ where: { email } })
  // Always succeed to avoid enumeration. Only actually send if the user
  // exists and is not already verified.
  if (user && !user.emailVerifiedAt) {
    const rawToken = generateToken()
    await db.emailVerificationToken.create({
      data: {
        id: createId(),
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
      },
    })
    const link = `${appUrl()}/verify?token=${encodeURIComponent(rawToken)}`
    await sendEmail({
      to: email,
      subject: 'Verify your StudyMind CRM account',
      body:
        `Hello,\n\n` +
        `Here is a fresh verification link, valid for 24 hours:\n\n${link}\n\n` +
        `— StudyMind CRM`,
    }).catch((err) => {
      logger.error({ err }, 'auth.resend.email_send_failed')
    })
    await writeAuditLogEntry(db, {
      actorId: user.id,
      action: 'auth.email_verification_resent',
      target: { type: 'User', id: user.id },
    })
  }

  return { ok: true, message: 'If that account exists and is unverified, a new link has been sent.' }
}

/* -------------------------------------------------------------------------- */
/* forgot password                                                             */
/* -------------------------------------------------------------------------- */

export async function requestPasswordReset(emailRaw: string): Promise<ActionResult> {
  const email = emailRaw.trim().toLowerCase()
  if (!email) return { ok: false, error: 'Email is required.' }

  const ip = await clientIp()
  const okIp = await requireRateLimit('forgot:ip', ip)
  const okEmail = await requireRateLimit('forgot:email', email)
  if (!okIp || !okEmail) {
    // Even rate-limit messages are uniform — do not reveal whether the email
    // exists.
    return {
      ok: true,
      message: 'If that account exists, a password reset link has been sent.',
    }
  }

  const user = await db.user.findUnique({ where: { email } })
  if (user && user.passwordHash) {
    const rawToken = generateToken()
    await db.passwordResetToken.create({
      data: {
        id: createId(),
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    })
    const link = `${appUrl()}/reset?token=${encodeURIComponent(rawToken)}`
    await sendEmail({
      to: email,
      subject: 'Reset your StudyMind CRM password',
      body:
        `Hello,\n\n` +
        `Use the link below to reset your StudyMind CRM password. It expires in 1 hour.\n\n${link}\n\n` +
        `If you did not request this, you can safely ignore this email.\n\n— StudyMind CRM`,
    }).catch((err) => {
      logger.error({ err }, 'auth.forgot.email_send_failed')
    })
    await writeAuditLogEntry(db, {
      actorId: user.id,
      action: 'auth.password_reset_requested',
      target: { type: 'User', id: user.id },
    })
  }

  return {
    ok: true,
    message: 'If that account exists, a password reset link has been sent.',
  }
}

/* -------------------------------------------------------------------------- */
/* accept invite (admin-issued)                                                 */
/* -------------------------------------------------------------------------- */

export interface AcceptInviteInput {
  token: string
  password: string
}

export type AcceptInviteResult =
  | { ok: true; email: string }
  | { ok: false; error: string }

/**
 * Accept an admin-issued invite. The invite token is an EmailVerificationToken
 * row issued by `admin.users.invite`; the target User row is identified by
 * `passwordHash IS NULL && emailVerifiedAt IS NULL`. On success we set the
 * password, mark the email verified, and the caller can sign in.
 */
export async function acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult> {
  const { token, password } = input
  if (!token) return { ok: false, error: 'Invite token is missing.' }

  try {
    assertStrongPassword(password)
  } catch (e) {
    if (e instanceof BusinessError) return { ok: false, error: e.message }
    throw e
  }

  const tokenHash = hashToken(token)
  const row = await db.emailVerificationToken.findUnique({ where: { tokenHash } })
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'This invite link is invalid or has expired.' }
  }
  const user = await db.user.findUnique({ where: { id: row.userId } })
  if (!user) return { ok: false, error: 'This invite link is invalid or has expired.' }
  if (user.passwordHash) {
    return { ok: false, error: 'This invite has already been accepted.' }
  }
  if (user.deactivatedAt) {
    return { ok: false, error: 'This account is no longer active.' }
  }

  const passwordHash = await hashPassword(password)
  const now = new Date()
  await db.$transaction([
    db.emailVerificationToken.update({
      where: { id: row.id },
      data: { usedAt: now },
    }),
    db.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        emailVerifiedAt: now,
        mustResetPassword: false,
        failedSignInAttempts: 0,
        lockedUntil: null,
      },
    }),
  ])

  await writeAuditLogEntry(db, {
    actorId: user.id,
    action: 'auth.user_invite_accepted',
    target: { type: 'User', id: user.id },
  })

  return { ok: true, email: user.email }
}

/* -------------------------------------------------------------------------- */
/* reset password                                                              */
/* -------------------------------------------------------------------------- */

export interface ResetPasswordInput {
  token: string
  password: string
}

export type ResetPasswordResult =
  | { ok: true; email: string }
  | { ok: false; error: string }

export async function resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
  const { token, password } = input
  if (!token) return { ok: false, error: 'Reset token is missing.' }

  try {
    assertStrongPassword(password)
  } catch (e) {
    if (e instanceof BusinessError) return { ok: false, error: e.message }
    throw e
  }

  const tokenHash = hashToken(token)
  const row = await db.passwordResetToken.findUnique({ where: { tokenHash } })
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'This reset link is invalid or has expired.' }
  }

  const user = await db.user.findUnique({ where: { id: row.userId } })
  if (!user) return { ok: false, error: 'This reset link is invalid or has expired.' }

  // Reuse-prevention: reject if the new password matches the current one.
  if (user.passwordHash && (await verifyPassword(password, user.passwordHash))) {
    return { ok: false, error: 'Choose a password you have not used recently.' }
  }

  const passwordHash = await hashPassword(password)
  const now = new Date()
  await db.$transaction([
    db.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: now },
    }),
    db.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        failedSignInAttempts: 0,
        lockedUntil: null,
        mustResetPassword: false,
      },
    }),
  ])

  await writeAuditLogEntry(db, {
    actorId: user.id,
    action: 'auth.password_reset_completed',
    target: { type: 'User', id: user.id },
  })

  return { ok: true, email: user.email }
}

