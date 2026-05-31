// Gmail MailSyncProvider adapter tests (ADR 0021 Phase 2). The adapter is a
// thin pass-through to GmailClient — these tests pin the shape conversions
// (snake_case ⇄ normalised) and the lazy-construction contract.

import { describe, expect, it, vi } from 'vitest'

import { MailFeatureUnsupportedError } from '@studymind/core/mail'

import { createGmailMailSyncProvider } from './mail-provider'

// Use a fake gmail SDK factory so no token/auth/network is involved.
function fakeSdk() {
  return {
    users: {
      messages: {
        get: vi.fn(async ({ id }: { id: string }) => ({
          data: {
            id,
            threadId: 't_1',
            internalDate: '1700000000000',
            payload: {
              headers: [
                { name: 'From', value: 'a@x.test' },
                { name: 'To', value: 'b@x.test' },
                { name: 'Subject', value: 'hello' },
              ],
              body: { data: Buffer.from('hi there', 'utf8').toString('base64url') },
              parts: [
                {
                  filename: 'file.pdf',
                  mimeType: 'application/pdf',
                  body: { attachmentId: 'att_1', size: 123 },
                },
              ],
            },
          },
        })),
        send: vi.fn(async () => ({ data: { id: 'm_sent', threadId: 't_1' } })),
        attachments: {
          get: vi.fn(async () => ({
            data: { data: Buffer.from('PDFBYTES').toString('base64url') },
          })),
        },
      },
      history: {
        list: vi.fn(async () => ({
          data: {
            historyId: '4242',
            history: [
              {
                messagesAdded: [
                  { message: { id: 'm_1', threadId: 't_1' } },
                  { message: { id: 'm_2', threadId: 't_2' } },
                ],
              },
            ],
          },
        })),
      },
      threads: {
        modify: vi.fn(async () => ({ data: {} })),
        trash: vi.fn(async () => ({ data: {} })),
        untrash: vi.fn(async () => ({ data: {} })),
      },
      labels: {
        list: vi.fn(async () => ({
          data: {
            labels: [
              { id: 'INBOX', name: 'INBOX' },
              { id: 'Label_7', name: 'Admissions' },
            ],
          },
        })),
      },
      watch: vi.fn(async () => ({
        data: { historyId: '4242', expiration: '1700000000000' },
      })),
      stop: vi.fn(async () => ({})),
      getProfile: vi.fn(async () => ({ data: { historyId: '4242' } })),
    },
  }
}

describe('createGmailMailSyncProvider', () => {
  it('exposes provider id and accountId', () => {
    const p = createGmailMailSyncProvider({
      accountId: 'acc_1',
      agentId: 'u_1',
      clientOptions: { factory: fakeSdk as never },
    })
    expect(p.provider).toBe('gmail')
    expect(p.accountId).toBe('acc_1')
  })

  it('normalises a fetched message', async () => {
    const p = createGmailMailSyncProvider({
      accountId: 'acc_1',
      agentId: 'u_1',
      clientOptions: { factory: fakeSdk as never },
    })
    const m = await p.fetchMessage('m_1')
    expect(m.id).toBe('m_1')
    expect(m.threadId).toBe('t_1')
    expect(m.internalDate).toBe(1700000000000)
    expect(m.headers).toContainEqual({ name: 'Subject', value: 'hello' })
    expect(m.body).toBe('hi there')
    expect(m.attachments).toEqual([
      { attachmentId: 'att_1', filename: 'file.pdf', mimeType: 'application/pdf', sizeBytes: 123 },
    ])
  })

  it('maps history → MailChangeBatch with a forward cursor', async () => {
    const p = createGmailMailSyncProvider({
      accountId: 'acc_1',
      agentId: 'u_1',
      clientOptions: { factory: fakeSdk as never },
    })
    const batch = await p.listChangesSince('4000')
    expect(batch.nextCursor).toBe('4242')
    expect(batch.added).toEqual([
      { messageId: 'm_1', threadId: 't_1' },
      { messageId: 'm_2', threadId: 't_2' },
    ])
  })

  it('listChangesSince requires a baseline cursor on Gmail', async () => {
    const p = createGmailMailSyncProvider({
      accountId: 'acc_1',
      agentId: 'u_1',
      clientOptions: { factory: fakeSdk as never },
    })
    await expect(p.listChangesSince(null)).rejects.toThrow(/baseline cursor/i)
  })

  it('sendRaw passes through to the SDK and normalises the ref', async () => {
    const p = createGmailMailSyncProvider({
      accountId: 'acc_1',
      agentId: 'u_1',
      clientOptions: { factory: fakeSdk as never },
    })
    const ref = await p.sendRaw({ raw: 'RFC5322-base64url' })
    expect(ref).toEqual({ id: 'm_sent', threadId: 't_1' })
  })

  it('setupPush returns a cursor + expiry derived from the watch response', async () => {
    const p = createGmailMailSyncProvider({
      accountId: 'acc_1',
      agentId: 'u_1',
      clientOptions: { factory: fakeSdk as never },
    })
    const sub = await p.setupPush({ topicOrUrl: 'projects/x/topics/gmail' })
    expect(sub.cursor).toBe('4242')
    expect(sub.expiresAtMs).toBe(1700000000000)
  })

  // Ensures that nothing in the adapter file references MailFeatureUnsupportedError
  // by accident — keeps the import live for when an unsupported provider
  // appears later. Pure smoke test.
  it('exports MailFeatureUnsupportedError for downstream providers', () => {
    expect(new MailFeatureUnsupportedError('imap', 'push').code).toBe(
      'MAIL_FEATURE_UNSUPPORTED',
    )
  })

  // --- Phase 5 two-way action sync: Gmail system-label mappings ---
  function providerWithSpy() {
    const sdk = fakeSdk()
    const p = createGmailMailSyncProvider({
      accountId: 'acc_1',
      agentId: 'u_1',
      clientOptions: { factory: () => sdk as never },
    })
    return { p, modify: sdk.users.threads.modify, sdk }
  }

  it('setReadState removes/adds the UNREAD label', async () => {
    const { p, modify } = providerWithSpy()
    await p.setReadState('t_1', true)
    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 't_1',
        requestBody: { addLabelIds: [], removeLabelIds: ['UNREAD'] },
      }),
    )
    await p.setReadState('t_1', false)
    expect(modify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestBody: { addLabelIds: ['UNREAD'], removeLabelIds: [] },
      }),
    )
  })

  it('setArchived removes/adds INBOX', async () => {
    const { p, modify } = providerWithSpy()
    await p.setArchived('t_1', true)
    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { addLabelIds: [], removeLabelIds: ['INBOX'] },
      }),
    )
  })

  it('setStarred adds/removes STARRED', async () => {
    const { p, modify } = providerWithSpy()
    await p.setStarred('t_1', true)
    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { addLabelIds: ['STARRED'], removeLabelIds: [] },
      }),
    )
  })

  it('setTrashed routes to trash / untrash', async () => {
    const { p, sdk } = providerWithSpy()
    await p.setTrashed('t_1', true)
    expect(sdk.users.threads.trash).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't_1' }),
    )
    await p.setTrashed('t_1', false)
    expect(sdk.users.threads.untrash).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't_1' }),
    )
  })

  it('listLabels surfaces id + name', async () => {
    const { p } = providerWithSpy()
    const labels = await p.listLabels()
    expect(labels).toContainEqual({ id: 'Label_7', name: 'Admissions' })
  })
})
