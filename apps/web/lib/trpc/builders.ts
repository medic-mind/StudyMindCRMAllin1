// tRPC procedure builders. See CLAUDE.md Section 27.
// `protectedProcedure` requires a session and applies the rate-limit middleware.
// `auditedProcedure` additionally injects ctx.audit and verifies it was called
// before the procedure resolves (runtime check on mutations that touch sensitive
// rows; see CLAUDE.md §27 audit context).

import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import type { PrismaClient } from '@prisma/client'
import { ZodError } from 'zod'

import { writeAuditLogEntry, type WriteAuditLogEntryInput } from '@studymind/audit'

import { rateLimit } from './rate-limit'

export type UserRole =
  | 'super_admin'
  | 'admin'
  | 'ops_manager'
  | 'agent'
  | 'finance'
  | 'dsl'
  | 'read_only'

export interface SessionUser {
  id: string
  email: string
  role: UserRole
  mustResetPassword?: boolean
  /** ISO string when MFA was last enabled, or null. CLAUDE.md §20. */
  totpEnabledAt?: string | null
  /** The Session row id (when one exists for this cookie). ADR 0010 chunk 7. */
  sessionId?: string
}

export type AuditCallInput = Omit<WriteAuditLogEntryInput, 'actorId' | 'requestId'>

export interface AuditRecorder {
  /** Records the audit and remembers it was called for the current procedure. */
  (input: AuditCallInput): Promise<string>
  /** Internal flag flipped on first call. Used by auditedProcedure. */
  called: boolean
}

export interface TrpcContext {
  user: SessionUser | null
  requestId: string
  db: PrismaClient
  audit: AuditRecorder
  /**
   * Subset of the inbound request headers needed for security checks
   * (CSRF Origin/Host comparison, CLAUDE.md §44.2). Empty when running
   * from RSC-side server actions where there is no HTTP request.
   */
  headers: { origin: string | null; host: string | null }
}

export interface AuthedTrpcContext extends Omit<TrpcContext, 'user'> {
  user: SessionUser
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // Forward unexpected errors to Sentry. Validation/auth errors are noisy
    // and expected, so we only capture INTERNAL_SERVER_ERROR (real bugs per
    // CLAUDE.md §27).
    if (error.code === 'INTERNAL_SERVER_ERROR') {
      const sentry = (globalThis as unknown as {
        Sentry?: { captureException: (e: unknown, hint?: { tags?: Record<string, string> }) => void }
      }).Sentry
      sentry?.captureException(error, { tags: { surface: 'trpc' } })
    }
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    }
  },
})

export const router = t.router
export const middleware = t.middleware
export const publicProcedure = t.procedure

/**
 * CSRF guard. Mutations require the Origin host to match Host (Same-Origin).
 * Webhook routes are exempt — they authenticate by signature instead and do
 * not flow through tRPC. CLAUDE.md §44.2.
 *
 * Queries (read-only) are not gated: GET requests are not state-changing and
 * Origin is unreliable on cross-origin GETs from clients we want to support
 * (e.g. internal scripts). The tight gate is on mutations.
 */
const csrfMiddleware = t.middleware(async ({ ctx, type, next }) => {
  if (type === 'mutation') {
    const origin = ctx.headers.origin
    const host = ctx.headers.host
    // RSC server callers have neither — they are in-process and not driven
    // by an external HTTP request. Skip the check in that case.
    if (origin === null && host === null) {
      return next()
    }
    if (!origin || !host) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Origin header required' })
    }
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid Origin' })
    }
    if (originHost !== host) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Cross-origin mutation rejected' })
    }
  }
  return next()
})

const enforceUserAndRateLimitMiddleware = t.middleware(async ({ ctx, path, next }) => {
  const user = ctx.user
  if (!user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  const allowed = await rateLimit({ userId: user.id, procedure: path })
  if (!allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Slow down — try again in a moment.',
    })
  }
  const authedCtx: AuthedTrpcContext = {
    user,
    requestId: ctx.requestId,
    db: ctx.db,
    audit: ctx.audit,
    headers: ctx.headers,
  }
  return next({ ctx: authedCtx })
})

const auditMiddleware = t.middleware(async ({ ctx, type, path, next }) => {
  // Reset the called flag for this procedure invocation.
  ctx.audit.called = false
  const result = await next({ ctx })
  if (type === 'mutation' && result.ok && !ctx.audit.called) {
    // Hard fail: a mutation that goes through auditedProcedure but never calls
    // ctx.audit is a programmer error. This is the runtime backstop for the
    // ESLint rule in tools/eslint-rules/require-audit.ts.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `auditedProcedure '${path}' returned without calling ctx.audit`,
    })
  }
  return result
})

/**
 * Gate procedures behind `mustResetPassword`. A user with the flag set may
 * only call procedures that opt out via `bypassMustReset` (the change-
 * password procedure, and the sign-out path). Everything else returns
 * FORBIDDEN until they pick a new password. ADR 0010.
 */
const mustResetPasswordMiddleware = t.middleware(async ({ ctx, next }) => {
  const user = ctx.user
  if (user?.mustResetPassword) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must set a new password before continuing.',
    })
  }
  return next()
})

export const protectedProcedure = publicProcedure
  .use(csrfMiddleware)
  .use(enforceUserAndRateLimitMiddleware)
  .use(mustResetPasswordMiddleware)

/**
 * Same as protectedProcedure but skips the mustResetPassword gate. Intended
 * for the change-password procedure and any other path that the user must
 * be allowed to reach while holding the reset flag.
 */
export const protectedProcedureBypassMustReset = publicProcedure
  .use(csrfMiddleware)
  .use(enforceUserAndRateLimitMiddleware)

export const auditedProcedure = protectedProcedure.use(auditMiddleware)

/**
 * Audited variant that skips the mustResetPassword gate. Use this for the
 * change-password mutation: the user must be allowed to call it while the
 * flag is set, and we still want the audit-call enforcement.
 */
export const auditedProcedureBypassMustReset =
  protectedProcedureBypassMustReset.use(auditMiddleware)

/**
 * Narrows ctx.user from `SessionUser | null` to `SessionUser`. Use inside
 * resolvers that come through protectedProcedure or auditedProcedure — the
 * middleware has already enforced the user is present, this just re-asserts
 * it for TypeScript without weakening the runtime contract.
 */
export function requireUser(ctx: TrpcContext): SessionUser {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return ctx.user
}

/**
 * Restricted-access enforcement is a no-op in v1.
 *
 * The safeguarding workflow that drove this gate was removed in ADR 0013;
 * the function is retained as a stable extension point so that callers
 * across protected procedures keep compiling without churn, and so that a
 * future reinstatement of the safeguarding workflow has an obvious seam.
 *
 * Parameters are accepted but ignored.
 */
export async function enforceRestrictedAccess(
  _ctx: TrpcContext,
  _contactId: string,
  _purpose: string,
): Promise<void> {
  return
}

/** Build the audit recorder for a request. */
export function createAuditRecorder(
  db: PrismaClient,
  ctx: { actorId: string | null; requestId: string },
): AuditRecorder {
  const fn = (async (input: AuditCallInput) => {
    const id = await writeAuditLogEntry(db, {
      ...input,
      actorId: ctx.actorId,
      requestId: ctx.requestId,
    })
    fn.called = true
    return id
  }) as AuditRecorder
  fn.called = false
  return fn
}
