// mail two-way action sync tests (ADR 0021 Phase 5). Mocks the provider
// dispatcher + realtime bus; verifies each mutation hits the live provider,
// reflects on the Conversation head, audits, and is RBAC/precondition-gated.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuditRecorder, SessionUser, TrpcContext, UserRole } from '@/lib/trpc/builders'

const { fakeProvider } = vi.hoisted(() => ({
  fakeProvider: {
    accountId: 'acc_1',
    provider: 'gmail',
    setReadState: vi.fn(async () => {}),
    setArchived: vi.fn(async () => {}),
    setStarred: vi.fn(async () => {}),
    setTrashed: vi.fn(async () => {}),
    modifyLabels: vi.fn(async () => {}),
    listLabels: vi.fn(async () => [{ id: 'Label_1', name: 'Admissions' }]),
  },
}))

const { sendReplyMock, sendEmailMock, applyMailMock, saveDraftMock, sendDraftMock, fakeGmailClient } =
  vi.hoisted(() => ({
    sendReplyMock: vi.fn(async () => ({
      outboundEmailIntentId: 'oei_1',
      gmailMessageId: 'm_sent',
      gmailThreadId: 'thread_1',
      status: 'sent' as const,
      replayed: false,
    })),
    sendEmailMock: vi.fn(async () => ({
      outboundEmailIntentId: 'oei_2',
      gmailMessageId: 'm_new',
      gmailThreadId: 'thread_new',
      status: 'sent' as const,
      replayed: false,
    })),
    applyMailMock: vi.fn(async () => ({})),
    saveDraftMock: vi.fn(async () => ({ draftId: 'd1', messageId: 'm_d', threadId: '' })),
    sendDraftMock: vi.fn(async () => ({
      outboundEmailIntentId: 'oei_d',
      gmailMessageId: 'm_d',
      gmailThreadId: 'thread_d',
      status: 'sent' as const,
      replayed: false,
    })),
    fakeGmailClient: {
      deleteDraft: vi.fn(async () => {}),
      listDrafts: vi.fn(async () => []),
      getDraft: vi.fn(async () => ({ draftId: 'd1', message: { headers: [], body: '' } })),
    },
  }))

vi.mock('@/lib/mail/get-sync-provider', () => ({
  getMailSyncProvider: vi.fn(async () => fakeProvider),
}))
vi.mock('@studymind/core/realtime', () => ({ publishConversationUpdate: vi.fn() }))
vi.mock('@studymind/core/mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@studymind/core/mail')>()),
  applyMailToConversation: applyMailMock,
}))
vi.mock('@studymind/integration-gmail/outbound', () => ({
  sendReply: sendReplyMock,
  sendEmail: sendEmailMock,
  saveDraft: saveDraftMock,
  sendDraftMessage: sendDraftMock,
}))
vi.mock('@studymind/integration-gmail/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@studymind/integration-gmail/client')>()),
  createClientForAgent: vi.fn(async () => fakeGmailClient),
}))

import { mailRouter } from './mail'

interface Head {
  id: string
  provider: string | null
  externalThreadId: string | null
  mailAccountId: string | null
  contactId: string | null
  lastMessageAt: Date
  unreadCount: number
  status: string
}

function emailHead(over: Partial<Head> = {}): Head {
  return {
    id: 'cv_1',
    provider: 'email',
    externalThreadId: 'thread_1',
    mailAccountId: 'acc_1',
    contactId: 'c_1',
    lastMessageAt: new Date('2026-05-31T10:00:00Z'),
    unreadCount: 2,
    status: 'open',
    ...over,
  }
}

function makeCtx(opts: { role?: UserRole; head?: Head | null }): {
  ctx: TrpcContext
  audit: ReturnType<typeof vi.fn>
  updates: Array<Record<string, unknown>>
} {
  const head = opts.head === undefined ? emailHead() : opts.head
  const updates: Array<Record<string, unknown>> = []
  const audit = vi.fn(async (_input: unknown) => 'a1')
  const wrapped: AuditRecorder = (async (i: unknown) => {
    ;(wrapped as unknown as { called: boolean }).called = true
    return audit(i)
  }) as AuditRecorder
  ;(wrapped as unknown as { called: boolean }).called = false

  const db = {
    conversation: {
      findUnique: async () => head,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
        return { ...head, ...data }
      },
    },
    mailAccount: {
      findUnique: async () => ({ ownerUserId: 'u_owner' }),
      findFirst: async () => ({
        id: 'acc_1',
        provider: 'gmail',
        ownerUserId: 'u_owner',
        address: 'info@studymind.co.uk',
        status: 'connected',
      }),
    },
    interaction: {
      findFirst: async () => ({
        payload: {
          from: ['parent@example.test'],
          subject: 'UCAT help',
          messageIdHeader: '<abc@mail.gmail.com>',
        },
      }),
    },
    // No connected Gmail mailbox in the test env, so the self-heal bridge can't
    // resolve one and the no-mailAccount path still surfaces a BAD_REQUEST.
    gmailMailbox: {
      findFirst: async () => null,
    },
  }
  const user: SessionUser = { id: 'u_me', email: 'me@studymind.co.uk', role: opts.role ?? 'sales_executive' }
  const ctx: TrpcContext = {
    user,
    requestId: 'req_1',
    db: db as never,
    audit: wrapped,
    headers: { origin: null, host: null },
  }
  return { ctx, audit, updates }
}

beforeEach(() => vi.clearAllMocks())

describe('mail.thread.setRead', () => {
  it('marks read on the live mailbox, zeroes unread, audits', async () => {
    const { ctx, audit, updates } = makeCtx({})
    await mailRouter.createCaller(ctx).thread.setRead({ conversationId: 'cv_1', read: true })
    expect(fakeProvider.setReadState).toHaveBeenCalledWith('thread_1', true)
    expect(updates[0]).toEqual({ unreadCount: 0 })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail.thread_read_changed' }),
    )
  })

  it('is forbidden for a Virtual Assistant', async () => {
    const { ctx } = makeCtx({ role: 'virtual_assistant' })
    await expect(
      mailRouter.createCaller(ctx).thread.setRead({ conversationId: 'cv_1', read: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(fakeProvider.setReadState).not.toHaveBeenCalled()
  })
})

describe('mail.thread.setArchived / setTrashed', () => {
  it('archives → status archived', async () => {
    const { ctx, updates } = makeCtx({})
    await mailRouter.createCaller(ctx).thread.setArchived({ conversationId: 'cv_1', archived: true })
    expect(fakeProvider.setArchived).toHaveBeenCalledWith('thread_1', true)
    expect(updates[0]).toEqual({ status: 'archived' })
  })

  it('trashes via the provider (reversible) and audits', async () => {
    const { ctx, audit } = makeCtx({})
    await mailRouter.createCaller(ctx).thread.setTrashed({ conversationId: 'cv_1', trashed: true })
    expect(fakeProvider.setTrashed).toHaveBeenCalledWith('thread_1', true)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail.thread_trashed' }),
    )
  })
})

describe('preconditions', () => {
  it('rejects a non-email thread', async () => {
    const { ctx } = makeCtx({ head: emailHead({ provider: 'trengo', externalThreadId: null }) })
    await expect(
      mailRouter.createCaller(ctx).thread.setRead({ conversationId: 'cv_1', read: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects an email thread whose account is not imported', async () => {
    const { ctx } = makeCtx({ head: emailHead({ mailAccountId: null }) })
    await expect(
      mailRouter.createCaller(ctx).thread.setArchived({ conversationId: 'cv_1', archived: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('404s a missing conversation', async () => {
    const { ctx } = makeCtx({ head: null })
    await expect(
      mailRouter.createCaller(ctx).thread.setStarred({ conversationId: 'cv_x', starred: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('mail.compose', () => {
  it('sends a new email and creates the email head, audits', async () => {
    const { ctx, audit } = makeCtx({})
    const r = await mailRouter.createCaller(ctx).compose({
      mailAccountId: 'acc_1',
      to: ['parent@example.test'],
      subject: 'Welcome to StudyMind',
      body: 'Hello — here is your onboarding.',
    })
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'u_owner',
        fromAddress: 'info@studymind.co.uk',
        toAddresses: ['parent@example.test'],
        subject: 'Welcome to StudyMind',
      }),
    )
    expect(applyMailMock).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ provider: 'email', externalThreadId: 'thread_new' }),
    )
    expect(r.threadId).toBe('thread_new')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail.composed' }),
    )
  })

  it('is forbidden for a Virtual Assistant', async () => {
    const { ctx } = makeCtx({ role: 'virtual_assistant' })
    await expect(
      mailRouter.createCaller(ctx).compose({
        mailAccountId: 'acc_1',
        to: ['p@x.test'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})

describe('mail.drafts', () => {
  it('save creates/updates a Gmail draft and returns its id', async () => {
    const { ctx } = makeCtx({})
    const r = await mailRouter.createCaller(ctx).drafts.save({
      mailAccountId: 'acc_1',
      to: ['parent@example.test'],
      subject: 'Half-written',
      body: 'In progress…',
    })
    expect(saveDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'u_owner', subject: 'Half-written' }),
    )
    expect(r.draftId).toBe('d1')
  })

  it('send converts the draft (no duplicate), creates the head, audits', async () => {
    const { ctx, audit } = makeCtx({})
    const r = await mailRouter.createCaller(ctx).drafts.send({
      mailAccountId: 'acc_1',
      draftId: 'd1',
      to: ['parent@example.test'],
      subject: 'Done',
    })
    expect(sendDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'd1', toAddresses: ['parent@example.test'] }),
    )
    expect(applyMailMock).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ provider: 'email', externalThreadId: 'thread_d' }),
    )
    expect(r.threadId).toBe('thread_d')
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mail.draft_sent' }))
  })

  it('delete removes the Gmail draft and audits', async () => {
    const { ctx, audit } = makeCtx({})
    await mailRouter.createCaller(ctx).drafts.delete({ mailAccountId: 'acc_1', draftId: 'd1' })
    expect(fakeGmailClient.deleteDraft).toHaveBeenCalledWith('d1')
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'mail.draft_deleted' }))
  })

  it('save is forbidden for a Virtual Assistant', async () => {
    const { ctx } = makeCtx({ role: 'virtual_assistant' })
    await expect(
      mailRouter.createCaller(ctx).drafts.save({ mailAccountId: 'acc_1', subject: 's', body: 'b' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('mail.thread.reply', () => {
  it('replies to the latest inbound via Gmail, updates the head, audits', async () => {
    const { ctx, audit, updates } = makeCtx({})
    await mailRouter
      .createCaller(ctx)
      .thread.reply({ conversationId: 'cv_1', body: 'Thanks, here are the details.' })
    expect(sendReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'u_owner',
        threadId: 'thread_1',
        toAddresses: ['parent@example.test'],
        originalMessageId: '<abc@mail.gmail.com>',
        subject: 'Re: UCAT help',
      }),
    )
    // The reply now quotes the original beneath the typed body (Gmail behaviour).
    const replyArg = (sendReplyMock.mock.calls as unknown[][])[0]?.[0] as { body: string }
    expect(replyArg.body).toContain('Thanks, here are the details.')
    expect(replyArg.body).toContain('wrote:')
    expect(updates[0]).toEqual(
      expect.objectContaining({ unreadCount: 0, status: 'open' }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail.thread_replied' }),
    )
  })

  it('reply-all Ccs the other recipients (excluding us), audits', async () => {
    const { ctx } = makeCtx({})
    await mailRouter
      .createCaller(ctx)
      .thread.reply({ conversationId: 'cv_1', body: 'Thanks all.', replyAll: true })
    const arg = (sendReplyMock.mock.calls as unknown[][])[0]?.[0] as {
      toAddresses: string[]
      cc?: string[]
    }
    expect(arg.toAddresses).toEqual(['parent@example.test'])
  })

  it('forwards the latest message as a new thread with Fwd: subject', async () => {
    const { ctx, audit } = makeCtx({})
    await mailRouter
      .createCaller(ctx)
      .thread.forward({ conversationId: 'cv_1', to: ['colleague@x.test'], body: 'FYI' })
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toAddresses: ['colleague@x.test'],
        subject: 'Fwd: UCAT help',
      }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail.thread_forwarded' }),
    )
  })

  it('is forbidden for a Virtual Assistant', async () => {
    const { ctx } = makeCtx({ role: 'virtual_assistant' })
    await expect(
      mailRouter.createCaller(ctx).thread.reply({ conversationId: 'cv_1', body: 'hi' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(sendReplyMock).not.toHaveBeenCalled()
  })
})

describe('mail.thread.setLabels', () => {
  it('applies add/remove via the provider', async () => {
    const { ctx, audit } = makeCtx({})
    await mailRouter
      .createCaller(ctx)
      .thread.setLabels({ conversationId: 'cv_1', add: ['Label_1'], remove: ['Label_2'] })
    expect(fakeProvider.modifyLabels).toHaveBeenCalledWith('thread_1', {
      add: ['Label_1'],
      remove: ['Label_2'],
    })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail.thread_labeled' }),
    )
  })

  it('rejects an empty change', async () => {
    const { ctx } = makeCtx({})
    await expect(
      mailRouter.createCaller(ctx).thread.setLabels({ conversationId: 'cv_1' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
