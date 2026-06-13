// Gmail client unit tests — invalid_grant detection + needs_reconnect flip.
// ADR 0012.

import { describe, expect, it, vi } from 'vitest'

const { userUpdate, mailboxUpdateMany } = vi.hoisted(() => ({
  userUpdate: vi.fn(async () => ({})),
  mailboxUpdateMany: vi.fn(async () => ({ count: 0 })),
}))

vi.mock('@studymind/db', () => ({
  db: {
    user: { update: userUpdate },
    gmailMailbox: { updateMany: mailboxUpdateMany },
  },
}))

import {
  createClientForAgent,
  isInvalidGrantError,
  isNotFoundError,
  markNeedsReconnect,
} from './client'

describe('isInvalidGrantError', () => {
  it('detects google response.data.error', () => {
    expect(
      isInvalidGrantError({ response: { data: { error: 'invalid_grant' } } }),
    ).toBe(true)
  })

  it('detects message text', () => {
    expect(isInvalidGrantError({ message: 'invalid_grant: bad refresh' })).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isInvalidGrantError(new Error('boom'))).toBe(false)
    expect(isInvalidGrantError(null)).toBe(false)
    expect(isInvalidGrantError(undefined)).toBe(false)
  })
})

describe('markNeedsReconnect', () => {
  it('flips status and clears watch expiry', async () => {
    await markNeedsReconnect('u_x')
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'u_x' },
      data: { gmailConnectionStatus: 'needs_reconnect' },
    })
    expect(mailboxUpdateMany).toHaveBeenCalledWith({
      where: { agentId: 'u_x', deletedAt: null },
      data: { watchExpiresAt: null },
    })
  })
})

describe('isNotFoundError', () => {
  it('detects code 404 and response.status 404', () => {
    expect(isNotFoundError({ code: 404 })).toBe(true)
    expect(isNotFoundError({ response: { status: 404 } })).toBe(true)
    expect(isNotFoundError({ status: '404' })).toBe(true)
  })
  it('returns false otherwise', () => {
    expect(isNotFoundError({ code: 500 })).toBe(false)
    expect(isNotFoundError(null)).toBe(false)
  })
})

// Two-way sync (ADR 0021 Phase 5): the history pull must surface label/delete
// changes as changedThreadIds (minus threads with a new message), and
// getThreadState must aggregate labels / map a 404 to null.
describe('listHistorySince — flag-change capture', () => {
  function fakeSdk(history: unknown[], historyId = '99') {
    return () =>
      ({
        users: {
          history: {
            list: vi.fn(async () => ({ data: { history, historyId } })),
          },
        },
      }) as never
  }

  it('captures label + delete changes, excludes threads with a new message', async () => {
    const client = await createClientForAgent({
      agentId: 'u_1',
      factory: fakeSdk([
        { messagesAdded: [{ message: { id: 'm1', threadId: 't_new' } }] },
        { labelsAdded: [{ message: { id: 'm2', threadId: 't_star' } }] },
        { labelsRemoved: [{ message: { id: 'm3', threadId: 't_read' } }] },
        { messagesDeleted: [{ message: { id: 'm4', threadId: 't_del' } }] },
        // A thread that both got a new message AND a label change → message wins.
        { labelsAdded: [{ message: { id: 'm5', threadId: 't_new' } }] },
      ]),
    })
    const res = await client.listHistorySince('10')
    expect(res.added).toEqual([{ messageId: 'm1', threadId: 't_new' }])
    expect([...res.changedThreadIds].sort()).toEqual(['t_del', 't_read', 't_star'])
    expect(res.newHistoryId).toBe('99')
  })
})

describe('getThreadState', () => {
  it('aggregates label ids across messages', async () => {
    const client = await createClientForAgent({
      agentId: 'u_1',
      factory: () =>
        ({
          users: {
            threads: {
              get: vi.fn(async () => ({
                data: {
                  messages: [
                    { labelIds: ['INBOX', 'UNREAD'] },
                    { labelIds: ['INBOX', 'STARRED'] },
                  ],
                },
              })),
            },
          },
        }) as never,
    })
    const state = await client.getThreadState('t_1')
    expect(state?.threadId).toBe('t_1')
    expect([...(state?.labelIds ?? [])].sort()).toEqual(['INBOX', 'STARRED', 'UNREAD'])
  })

  it('maps a 404 to null (thread permanently deleted)', async () => {
    const client = await createClientForAgent({
      agentId: 'u_1',
      factory: () =>
        ({
          users: {
            threads: {
              get: vi.fn(async () => {
                throw { code: 404 }
              }),
            },
          },
        }) as never,
    })
    expect(await client.getThreadState('gone')).toBeNull()
  })
})
