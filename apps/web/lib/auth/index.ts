// NextAuth v5 configuration. ADR 0010, CLAUDE.md §20 (auth/RBAC), §44.2.
//
// Strategy: JWT sessions (stateless cookie) plus a Prisma adapter so we can
// list/revoke server-side sessions later. Credentials provider only — no
// social login today; outbound OAuth (Gmail) is a separate flow under
// /api/oauth/* and does not produce a NextAuth session.
//
// Failed sign-ins go through packages/core/auth/lockout so an attacker
// cannot grind passwords. We deliberately return a single generic
// INVALID_CREDENTIALS code on every authentication failure to avoid
// account-enumeration leaks.

import { createId } from '@paralleldrive/cuid2'
import { PrismaAdapter } from '@auth/prisma-adapter'
import NextAuth, { CredentialsSignin } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { z } from 'zod'

import { BusinessError } from '@studymind/core/errors'
import { assertNotLocked, recordFailedAttempt, recordSuccessfulSignIn } from '@studymind/core/auth/lockout'
import { generateToken, hashToken, verifyPassword } from '@studymind/core/auth/passwords'
import { decryptFieldById } from '@studymind/core/safeguarding'
import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'

import type { UserRole } from '@/lib/trpc/builders'

import { pickPrimaryRole } from './pick-primary-role'
import { verifyRecoveryCode, verifyTotpCode } from './totp'

class AuthError extends CredentialsSignin {
  override code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // CLAUDE.md §20: optional TOTP factor. Empty / missing means the client
  // has not yet been told MFA is required; the authorize() callback throws
  // TOTP_REQUIRED in that case so the UI can render the second step.
  totpCode: z.string().optional(),
  recoveryCode: z.string().optional(),
})

const isProd = process.env.NODE_ENV === 'production'
const sessionCookieName = isProd ? '__Secure-studymind.session' : 'studymind.session'

export const { auth, handlers, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  // Trust the X-Forwarded-* headers from Railway's edge proxy so NextAuth
  // constructs callback URLs from the public domain (https://crm.studymind.co.uk)
  // instead of the container's internal bind (https://0.0.0.0:8080). Without
  // this, sign-in fails with error=Configuration and the error redirect lands
  // on 0.0.0.0:8080. Equivalent to AUTH_TRUST_HOST=true env, set here in code
  // so it works regardless of env config.
  trustHost: true,
  session: {
    strategy: 'jwt',
    maxAge: 12 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      name: sessionCookieName,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: isProd,
      },
    },
  },
  pages: {
    signIn: '/sign-in',
    verifyRequest: '/verify-email-sent',
    error: '/auth/error',
  },
  secret: process.env.AUTH_SECRET,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        totpCode: { label: 'TOTP code', type: 'text' },
        recoveryCode: { label: 'Recovery code', type: 'text' },
      },
      async authorize(credentials, req) {
        const parsed = credentialsSchema.safeParse(credentials)
        if (!parsed.success) {
          throw new AuthError('INVALID_CREDENTIALS')
        }
        const { email, password, totpCode, recoveryCode } = parsed.data

        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
          select: {
            id: true,
            email: true,
            name: true,
            passwordHash: true,
            emailVerifiedAt: true,
            mustResetPassword: true,
            failedSignInAttempts: true,
            lockedUntil: true,
            deactivatedAt: true,
            totpEnabledAt: true,
            totpSecretCipherId: true,
          },
        })
        // Generic error path — never reveal that an account does not exist.
        if (!user || !user.passwordHash || user.deactivatedAt) {
          throw new AuthError('INVALID_CREDENTIALS')
        }

        try {
          assertNotLocked(user)
        } catch (e) {
          if (e instanceof BusinessError && e.code === 'ACCOUNT_LOCKED') {
            throw new AuthError('ACCOUNT_LOCKED')
          }
          throw e
        }

        const ok = await verifyPassword(password, user.passwordHash)
        if (!ok) {
          await recordFailedAttempt(user, db)
          throw new AuthError('INVALID_CREDENTIALS')
        }

        if (!user.emailVerifiedAt) {
          throw new AuthError('EMAIL_NOT_VERIFIED')
        }

        // CLAUDE.md §20: TOTP gate. If MFA is enabled and the client has not
        // yet supplied a code, throw TOTP_REQUIRED so the UI can render the
        // second-step form. If a code/recovery is supplied, verify it; on
        // failure we return the generic INVALID_CREDENTIALS to avoid leaking
        // whether the password vs the second factor was wrong.
        if (user.totpEnabledAt && user.totpSecretCipherId) {
          if (!totpCode && !recoveryCode) {
            throw new AuthError('TOTP_REQUIRED')
          }
          let factorOk = false
          if (totpCode) {
            const secret = await decryptFieldById(db, {
              encryptedFieldId: user.totpSecretCipherId,
              actorId: user.id,
              purpose: 'auth.totp_verify',
            })
            factorOk = verifyTotpCode({ secret, code: totpCode })
            if (!factorOk) {
              await writeAuditLogEntry(db, {
                actorId: user.id,
                action: 'auth.totp_failed',
                target: { type: 'User', id: user.id },
              })
            }
          }
          if (!factorOk && recoveryCode) {
            factorOk = await verifyRecoveryCode({
              db,
              userId: user.id,
              code: recoveryCode,
            })
            if (factorOk) {
              await writeAuditLogEntry(db, {
                actorId: user.id,
                action: 'auth.recovery_code_used',
                target: { type: 'User', id: user.id },
              })
            }
          }
          if (!factorOk) {
            await recordFailedAttempt(user, db)
            throw new AuthError('INVALID_CREDENTIALS')
          }
        }

        const headers = req?.headers as Headers | undefined
        const ip = headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
        const ua = headers?.get('user-agent') ?? null
        await recordSuccessfulSignIn(user, db, { ip, ua })

        // Issue a Session row so the user can list and revoke their active
        // sessions. ADR 0010, chunk 7. The JWT carries the session id (`sid`);
        // the jwt callback below clears the token if the row is deleted.
        const rawSessionToken = generateToken()
        const sessionId = createId()
        await db.session.create({
          data: {
            id: sessionId,
            userId: user.id,
            sessionTokenHash: hashToken(rawSessionToken),
            expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
            ipAddress: ip,
            userAgent: ua,
          },
        })

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          mustResetPassword: user.mustResetPassword,
          totpEnabledAt: user.totpEnabledAt
            ? user.totpEnabledAt.toISOString()
            : null,
          sessionId,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        // First sign-in or session re-issue.
        token.uid = user.id as string
        token.email = user.email ?? token.email
        token.mustResetPassword = (user as { mustResetPassword?: boolean }).mustResetPassword ?? false
        token.sid = (user as { sessionId?: string }).sessionId
        token.totpEnabledAt =
          (user as { totpEnabledAt?: string | null }).totpEnabledAt ?? null
        token.roles = await loadRoles(user.id as string)
        token.rolesLoadedAt = Date.now()
      } else if (trigger === 'update' || shouldRefreshRoles(token)) {
        if (typeof token.uid === 'string') {
          token.roles = await loadRoles(token.uid)
          token.rolesLoadedAt = Date.now()
          // Refresh mustResetPassword + totpEnabledAt so middleware reflects
          // the latest state without a forced re-sign-in.
          const fresh = await db.user.findUnique({
            where: { id: token.uid },
            select: { mustResetPassword: true, totpEnabledAt: true },
          })
          if (fresh) {
            token.mustResetPassword = fresh.mustResetPassword
            token.totpEnabledAt = fresh.totpEnabledAt
              ? fresh.totpEnabledAt.toISOString()
              : null
          }
        }
      }
      // Server-side revocation: if the session id baked into the JWT no
      // longer exists, clear the token so the request is treated as
      // unauthenticated. Edge middleware does not run this callback (it
      // reads the JWT directly), but every node-runtime call (tRPC, server
      // components via auth()) does. CLAUDE.md §44.2.
      if (typeof token.sid === 'string') {
        const exists = await db.session.findUnique({
          where: { id: token.sid },
          select: { id: true },
        })
        if (!exists) {
          token.uid = undefined
          token.sid = undefined
        }
      }
      return token
    },
    async session({ session, token }) {
      if (token.uid && session.user) {
        const roles = (token.roles as UserRole[] | undefined) ?? []
        session.user.id = token.uid as string
        session.user.email = (token.email as string | undefined) ?? session.user.email
        session.user.roles = roles
        session.user.role = pickPrimaryRole(roles)
        session.user.mustResetPassword = Boolean(token.mustResetPassword)
        session.user.totpEnabledAt =
          typeof token.totpEnabledAt === 'string' ? token.totpEnabledAt : null
        if (typeof token.sid === 'string') session.user.sessionId = token.sid
      }
      return session
    },
  },
})

const ROLE_REFRESH_INTERVAL_MS = 60 * 1000

function shouldRefreshRoles(token: { rolesLoadedAt?: unknown }): boolean {
  const at = typeof token.rolesLoadedAt === 'number' ? token.rolesLoadedAt : 0
  return Date.now() - at > ROLE_REFRESH_INTERVAL_MS
}

async function loadRoles(userId: string): Promise<UserRole[]> {
  const rows = await db.roleAssignment.findMany({
    where: { userId },
    select: { role: true },
  })
  return rows.map((r) => r.role as UserRole)
}

export { pickPrimaryRole }
