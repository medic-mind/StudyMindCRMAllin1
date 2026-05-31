// Conversation internal-notes tests (ADR 0021 Phase 6). In-memory fake;
// verifies the note is written, mentions audit-notify colleagues (not self),
// and the staff gate.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuditRecorder, SessionUser, TrpcContext, UserRole } from '@/lib/trpc/builders'

import { inboxRouter } from './inbox'

function makeCtx(opts: { role?: UserRole; convo?: { id: string; contactId: string | null } | null }): {
  ctx: TrpcContext
  audits: Array<{ action: string; target?: { type: string; id: string } }>
  created: Array<Record<string, unknown>>
} {
  const convo = opts.convo === undefined ? { id: 'cv_1', contactId: 'c_1' } : opts.convo
  const created: Array<Record<string, unknown>> = []
  const audits: Array<{ action: string; target?: { type: string; id: string } }> = []
  const audit = vi.fn(async (i: { action: string; target?: { type: string; id: string } }) => {
    audits.push(i)
    return 'a'
  })
  const wrapped: AuditRecorder = (async (i: unknown) => {
    ;(wrapped as unknown as { called: boolean }).called = true
    return audit(i as { action: string })
  }) as AuditRecorder
  ;(wrapped as unknown as { called: boolean }).called = false

  const db = {
    conversation: { findUnique: async () => convo },
    interaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return data
      },
      findMany: async () => [],
    },
    user: { findMany: async () => [] },
  }
  const user: SessionUser = { id: 'u_me', email: 'me@studymind.co.uk', role: opts.role ?? 'virtual_assistant' }
  return {
    ctx: { user, requestId: 'r1', db: db as never, audit: wrapped, headers: { origin: null, host: null } },
    audits,
    created,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('inbox.conversations.notes.add', () => {
  it('writes an internal note and notifies mentioned colleagues (not self)', async () => {
    const { ctx, audits, created } = makeCtx({})
    await inboxRouter
      .createCaller(ctx)
      .conversations.notes.add({
        conversationId: 'cv_1',
        body: 'Parent prefers evening calls.',
        mentionUserIds: ['u_other', 'u_me'],
      })
    // Note Interaction written, scoped to the conversation, internal.
    expect(created[0]).toEqual(
      expect.objectContaining({
        type: 'note',
        contactId: 'c_1',
        payload: expect.objectContaining({ conversationId: 'cv_1', internal: true }),
      }),
    )
    // note_added audit + one mention audit (self skipped).
    expect(audits.map((a) => a.action)).toEqual([
      'conversation.note_added',
      'conversation.note_mentioned',
    ])
    const mention = audits.find((a) => a.action === 'conversation.note_mentioned')
    expect(mention?.target).toEqual({ type: 'User', id: 'u_other' })
  })

  it('allows a Virtual Assistant to add a note (§20)', async () => {
    const { ctx, created } = makeCtx({ role: 'virtual_assistant' })
    await inboxRouter
      .createCaller(ctx)
      .conversations.notes.add({ conversationId: 'cv_1', body: 'note' })
    expect(created).toHaveLength(1)
  })

  it('404s a missing conversation', async () => {
    const { ctx } = makeCtx({ convo: null })
    await expect(
      inboxRouter.createCaller(ctx).conversations.notes.add({ conversationId: 'x', body: 'n' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
