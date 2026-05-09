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

export type UserRole = 'admin' | 'ops_manager' | 'agent' | 'finance' | 'dsl' | 'read_only'

export interface SessionUser {
  id: string
  email: string
  role: UserRole
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
}

export interface AuthedTrpcContext extends Omit<TrpcContext, 'user'> {
  user: SessionUser
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
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

export const protectedProcedure = publicProcedure.use(enforceUserAndRateLimitMiddleware)

export const auditedProcedure = protectedProcedure.use(auditMiddleware)

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
 * Enforce the restricted-access policy for safeguarding (CLAUDE.md §42.3).
 *
 * If the contact has any active SafeguardingFlag at `restricted_access`, only
 * the assigned DSL or an admin may proceed. Every successful read writes a
 * `safeguarding.read_attempt` audit row carrying the caller's stated purpose.
 *
 * Throws TRPCError on violation. No-op when the contact is not restricted.
 */
export async function enforceRestrictedAccess(
  ctx: TrpcContext,
  contactId: string,
  purpose: string,
): Promise<void> {
  const flags = await ctx.db.safeguardingFlag.findMany({
    where: { contactId, deletedAt: null, state: 'restricted_access' },
    select: { id: true, dslUserId: true },
  })
  if (flags.length === 0) return
  const user = ctx.user
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' })
  const isAssignedDsl =
    user.role === 'dsl' && flags.some((f) => f.dslUserId === user.id)
  if (user.role !== 'admin' && !isAssignedDsl) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Contact is restricted; assigned DSL or admin only.',
    })
  }
  if (!purpose || purpose.trim().length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A non-empty purpose is required to read a restricted contact.',
    })
  }
  await ctx.audit({
    action: 'safeguarding.read_attempt',
    target: { type: 'Contact', id: contactId },
    purpose,
    after: { flagIds: flags.map((f) => f.id) },
  })
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
