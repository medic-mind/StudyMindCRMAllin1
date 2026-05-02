// tRPC procedure builders. See CLAUDE.md Section 27.
// protectedProcedure injects ctx.user, ctx.audit, ctx.requestId, plus rate-limit middleware.

import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import type { AuditLogInput } from '@studymind/audit'

export interface SessionUser {
  id: string
  email: string
}

export interface TrpcContext {
  user: SessionUser | null
  requestId: string
  audit: (input: AuditLogInput) => Promise<void>
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
})

export const router = t.router
export const publicProcedure = t.procedure

const enforceUserMiddleware = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, user: ctx.user } })
})

const rateLimitMiddleware = t.middleware(async ({ next }) => {
  // Skeleton — Redis sliding-window rate limiter goes here.
  return next()
})

export const protectedProcedure = publicProcedure
  .use(enforceUserMiddleware)
  .use(rateLimitMiddleware)
