// CSRF middleware unit tests. CLAUDE.md §44.2.
//
// We exercise the middleware through a tiny tRPC router so the test reflects
// real request flow (origin/host headers in TrpcContext, mutation vs query
// dispatch). Webhook routes don't go through tRPC and so don't appear here —
// they authenticate by signature (verified in the integration suites).

import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  createAuditRecorder,
  protectedProcedure,
  publicProcedure,
  router,
  type TrpcContext,
} from './builders'

// Minimal stub PrismaClient — the procedures below never touch it but
// TrpcContext requires a value of the expected shape.
const dbStub = {} as unknown as TrpcContext['db']

const testRouter = router({
  ping: publicProcedure.query(() => 'pong'),
  read: protectedProcedure.query(() => 'ok'),
  write: protectedProcedure
    .input(z.object({ value: z.string() }))
    .mutation(({ input }) => input.value),
})

function makeCtx(opts: {
  origin: string | null
  host: string | null
  userId?: string | null
}): TrpcContext {
  const requestId = 'test-request'
  const userId = opts.userId ?? 'user_test'
  return {
    user: userId
      ? { id: userId, email: 'sales@dev.studymind', role: 'sales_executive' }
      : null,
    requestId,
    db: dbStub,
    audit: createAuditRecorder(dbStub as never, { actorId: userId, requestId }),
    headers: { origin: opts.origin, host: opts.host },
  }
}

describe('CSRF middleware', () => {
  it('rejects cross-origin mutations', async () => {
    const caller = testRouter.createCaller(
      makeCtx({ origin: 'https://evil.example', host: 'crm.studymind.co.uk' }),
    )
    await expect(caller.write({ value: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    } satisfies Partial<TRPCError>)
  })

  it('allows same-origin mutations', async () => {
    const caller = testRouter.createCaller(
      makeCtx({
        origin: 'https://crm.studymind.co.uk',
        host: 'crm.studymind.co.uk',
      }),
    )
    expect(await caller.write({ value: 'hello' })).toBe('hello')
  })

  it('skips CSRF for RSC server callers (no headers)', async () => {
    const caller = testRouter.createCaller(makeCtx({ origin: null, host: null }))
    expect(await caller.write({ value: 'rsc' })).toBe('rsc')
  })

  it('does not gate queries (read paths)', async () => {
    const caller = testRouter.createCaller(
      makeCtx({ origin: 'https://other.example', host: 'crm.studymind.co.uk' }),
    )
    expect(await caller.read()).toBe('ok')
  })

  it('rejects mutation with malformed Origin', async () => {
    const caller = testRouter.createCaller(
      makeCtx({ origin: 'not-a-url', host: 'crm.studymind.co.uk' }),
    )
    await expect(caller.write({ value: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
