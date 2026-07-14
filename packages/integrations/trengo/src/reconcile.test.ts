// Tests for the Trengo status reconcile planner + detail fetcher (ADR 0020).
// The cron itself is integration-tested; here we lock the pure decision logic
// that converges the head to Trengo's source-of-truth state, and the
// endpoint-fallback behaviour of the per-ticket detail fetch.

import { describe, expect, it, vi } from 'vitest'

import { TrengoApiError } from './client'
import { type ReconcileHead, fetchTicketDetail, planReconcile } from './reconcile'
import type { NormalisedTicket } from './backfill'

function head(over: Partial<ReconcileHead> = {}): ReconcileHead {
  return {
    id: 'c1',
    trengoTicketId: 100,
    status: 'open',
    trengoAssigneeId: null,
    tags: [],
    contactId: 'contact-1',
    familyId: null,
    channel: 'whatsapp',
    trengoChannelId: null,
    trengoChannelName: null,
    lastMessageAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }
}

function ticket(over: Partial<NormalisedTicket> = {}): NormalisedTicket {
  return {
    id: 100,
    channel: 'whatsapp',
    trengoChannelId: null,
    trengoChannelName: null,
    status: 'open',
    statusKnown: true,
    assigneeId: null,
    assigneeKnown: true,
    subject: null,
    labels: [],
    labelsKnown: true,
    contact: { phone: null, email: null, name: null },
    createdAt: null,
    activityAt: null,
    ...over,
  }
}

describe('planReconcile — status', () => {
  it('closes a head that is still open here but closed on Trengo', () => {
    const plan = planReconcile(head({ status: 'open' }), ticket({ status: 'closed' }))
    expect(plan.statusEvent).toBe('ticket.closed')
    expect(plan.statusChange).toEqual({ from: 'open', to: 'closed' })
  })

  it('reopens a head that is closed here but open on Trengo', () => {
    const plan = planReconcile(head({ status: 'closed' }), ticket({ status: 'open' }))
    expect(plan.statusEvent).toBe('ticket.reopened')
    expect(plan.statusChange).toEqual({ from: 'closed', to: 'open' })
  })

  it('is a no-op when both agree (open)', () => {
    const plan = planReconcile(head({ status: 'open' }), ticket({ status: 'open' }))
    expect(plan.statusEvent).toBeNull()
    expect(plan.statusChange).toBeNull()
  })

  it('is a no-op when both agree (closed)', () => {
    const plan = planReconcile(head({ status: 'closed' }), ticket({ status: 'closed' }))
    expect(plan.statusEvent).toBeNull()
  })

  it('closes a snoozed head when Trengo shows the ticket closed (truth wins)', () => {
    const plan = planReconcile(head({ status: 'snoozed' }), ticket({ status: 'closed' }))
    expect(plan.statusEvent).toBe('ticket.closed')
    expect(plan.statusChange).toEqual({ from: 'snoozed', to: 'closed' })
  })

  it('leaves a snoozed head alone when Trengo shows open (snooze is local-open)', () => {
    const plan = planReconcile(head({ status: 'snoozed' }), ticket({ status: 'open' }))
    expect(plan.statusEvent).toBeNull()
  })

  it('does NOT reopen a closed head on an unrecognised Trengo status (fail closed, §8)', () => {
    const plan = planReconcile(
      head({ status: 'closed' }),
      ticket({ status: 'open', statusKnown: false }),
    )
    expect(plan.statusEvent).toBeNull()
    expect(plan.statusChange).toBeNull()
  })

  it('still closes on an explicit closed status even when the head was spam', () => {
    const plan = planReconcile(head({ status: 'spam' }), ticket({ status: 'closed' }))
    expect(plan.statusEvent).toBe('ticket.closed')
  })
})

describe('planReconcile — spam (Trengo Spam box import)', () => {
  it('marks a head spam when Trengo shows the ticket as spam', () => {
    const plan = planReconcile(head({ status: 'open' }), ticket({ status: 'spam' }))
    expect(plan.setSpam).toBe(true)
    expect(plan.statusEvent).toBeNull()
    expect(plan.statusChange).toEqual({ from: 'open', to: 'spam' })
  })

  it('is a no-op when both already agree on spam', () => {
    const plan = planReconcile(head({ status: 'spam' }), ticket({ status: 'spam' }))
    expect(plan.setSpam).toBe(false)
    expect(plan.statusChange).toBeNull()
  })

  it('reopens a spam head when Trengo un-marked it (now open)', () => {
    const plan = planReconcile(head({ status: 'spam' }), ticket({ status: 'open' }))
    expect(plan.statusEvent).toBe('ticket.reopened')
    expect(plan.setSpam).toBe(false)
    expect(plan.statusChange).toEqual({ from: 'spam', to: 'open' })
  })

  it('closes a spam head when Trengo shows it closed', () => {
    const plan = planReconcile(head({ status: 'spam' }), ticket({ status: 'closed' }))
    expect(plan.statusEvent).toBe('ticket.closed')
  })
})

describe('planReconcile — channel ("business number")', () => {
  it('stamps the channel when Trengo carries one the head lacks', () => {
    const plan = planReconcile(
      head({ trengoChannelId: null }),
      ticket({ trengoChannelId: 42, trengoChannelName: 'Support Manager' }),
    )
    expect(plan.channelId).toBe(42)
  })

  it('is a no-op when the channel already matches', () => {
    const plan = planReconcile(
      head({ trengoChannelId: 42 }),
      ticket({ trengoChannelId: 42 }),
    )
    expect(plan.channelId).toBeNull()
  })
})

describe('planReconcile — assignee', () => {
  it('applies the assignee when Trengo differs', () => {
    const plan = planReconcile(head({ trengoAssigneeId: null }), ticket({ assigneeId: 7 }))
    expect(plan.applyAssignee).toBe(true)
  })

  it('does not re-apply an unchanged assignee', () => {
    const plan = planReconcile(head({ trengoAssigneeId: 7 }), ticket({ assigneeId: 7 }))
    expect(plan.applyAssignee).toBe(false)
  })

  it('does not APPLY an assignee when Trengo reports none', () => {
    const plan = planReconcile(head({ trengoAssigneeId: 7 }), ticket({ assigneeId: null }))
    expect(plan.applyAssignee).toBe(false)
  })

  it('CLEARS our assignee when the ticket was unassigned in Trengo', () => {
    const plan = planReconcile(head({ trengoAssigneeId: 7 }), ticket({ assigneeId: null }))
    expect(plan.clearAssignee).toBe(true)
  })

  it('does not clear when neither side has an assignee', () => {
    const plan = planReconcile(head({ trengoAssigneeId: null }), ticket({ assigneeId: null }))
    expect(plan.clearAssignee).toBe(false)
  })

  it('does NOT clear when the payload carried no assignee key at all (fail closed, §8)', () => {
    const plan = planReconcile(
      head({ trengoAssigneeId: 7 }),
      ticket({ assigneeId: null, assigneeKnown: false }),
    )
    expect(plan.clearAssignee).toBe(false)
  })
})

describe('planReconcile — labels', () => {
  it('writes the full Trengo label set when it differs (removal included)', () => {
    const plan = planReconcile(
      head({ tags: ['vip', 'old'] }),
      ticket({ labels: ['vip'], labelsKnown: true }),
    )
    expect(plan.tags).toEqual(['vip'])
  })

  it('is a no-op when the label sets match regardless of order', () => {
    const plan = planReconcile(
      head({ tags: ['a', 'b'] }),
      ticket({ labels: ['b', 'a'], labelsKnown: true }),
    )
    expect(plan.tags).toBeNull()
  })

  it('does not clear labels when the ticket payload never carried a labels key', () => {
    const plan = planReconcile(
      head({ tags: ['keep'] }),
      ticket({ labels: [], labelsKnown: false }),
    )
    expect(plan.tags).toBeNull()
  })
})

describe('fetchTicketDetail', () => {
  it('reads /tickets/:id first and unwraps a { data } envelope', async () => {
    const request = vi.fn(async () => ({ data: { id: 100, status: 'CLOSED' } }))
    const res = await fetchTicketDetail(request as never, null, 100)
    expect(request).toHaveBeenCalledWith('GET', '/tickets/100')
    expect(res.endpoint).toBe('tickets')
    expect(res.deleted).toBe(false)
    expect(res.ticket?.status).toBe('closed')
  })

  it('reads a bare (un-enveloped) detail body', async () => {
    const request = vi.fn(async () => ({ id: 100, status: 'open' }))
    const res = await fetchTicketDetail(request as never, 'tickets', 100)
    expect(res.ticket?.status).toBe('open')
  })

  it('falls back to /conversations/:id on a 404 when the endpoint is undecided', async () => {
    const request = vi.fn(async (_m: string, path: string) => {
      if (path.startsWith('/tickets')) throw new TrengoApiError(404, path, null)
      return { data: { id: 100, status: 'open' } }
    })
    const res = await fetchTicketDetail(request as never, null, 100)
    expect(res.endpoint).toBe('conversations')
    expect(res.ticket?.status).toBe('open')
    expect(request).toHaveBeenCalledWith('GET', '/conversations/100')
  })

  it('treats a 404 on a PINNED /tickets endpoint as a deleted ticket', async () => {
    const request = vi.fn(async (_m: string, path: string) => {
      throw new TrengoApiError(404, path, null)
    })
    const res = await fetchTicketDetail(request as never, 'tickets', 100)
    expect(res.deleted).toBe(true)
    expect(res.ticket).toBeNull()
    // No fallback probe once pinned.
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('propagates auth/5xx errors instead of masking them as deleted', async () => {
    const request = vi.fn(async (_m: string, path: string) => {
      throw new TrengoApiError(401, path, null)
    })
    await expect(fetchTicketDetail(request as never, 'tickets', 100)).rejects.toBeInstanceOf(
      TrengoApiError,
    )
  })
})
