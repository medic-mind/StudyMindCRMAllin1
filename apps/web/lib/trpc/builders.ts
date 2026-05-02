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

const enforceUserMiddleware = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, user: ctx.user } })
})

const rateLimitMiddleware = t.middleware(async ({ ctx, path, next }) => {
  if (!ctx.user) return next()
  const allowed = await rateLimit({ userId: ctx.user.id, procedure: path })
  if (!allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Slow down — try again in a moment.',
    })
  }
  return next()
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

export const protectedProcedure = publicProcedure
  .use(enforceUserMiddleware)
  .use(rateLimitMiddleware)

export const auditedProcedure = protectedProcedure.use(auditMiddleware)

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
