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

import { isInvalidGrantError, markNeedsReconnect } from './client'

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
