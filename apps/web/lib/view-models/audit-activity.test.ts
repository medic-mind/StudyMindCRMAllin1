import { describe, expect, it } from 'vitest'

import {
  changedFieldsFromSnapshots,
  describeAuditAction,
  formatActor,
  toAuditActivityRow,
  type AuditActor,
} from './audit-activity'

describe('describeAuditAction', () => {
  it('maps known actions to friendly labels + categories', () => {
    expect(describeAuditAction('contact.viewed')).toEqual({ label: 'Viewed', category: 'view' })
    expect(describeAuditAction('contact.updated')).toEqual({ label: 'Edited', category: 'update' })
    expect(describeAuditAction('contact.created')).toEqual({ label: 'Created', category: 'create' })
    expect(describeAuditAction('contact.exported')).toEqual({
      label: 'Exported (CSV)',
      category: 'export',
    })
    expect(describeAuditAction('auth.signin_succeeded')).toEqual({
      label: 'Signed in',
      category: 'auth',
    })
  })

  it('falls back to a prettified label for unknown actions', () => {
    expect(describeAuditAction('card.moved')).toEqual({ label: 'Moved', category: 'update' })
    expect(describeAuditAction('document.removed')).toEqual({
      label: 'Removed',
      category: 'delete',
    })
    // unknown, no verb suffix → 'other'
    expect(describeAuditAction('widget.frobnicated').category).toBe('other')
  })
})

describe('formatActor', () => {
  const actor: AuditActor = { name: 'Jamie Rivers', email: 'jamie@studymind.co.uk' }
  it('returns System for a null actor id', () => {
    expect(formatActor(null, undefined)).toBe('System')
  })
  it('prefers name, then email, then Unknown user', () => {
    expect(formatActor('u1', actor)).toBe('Jamie Rivers')
    expect(formatActor('u1', { name: null, email: 'x@y.com' })).toBe('x@y.com')
    expect(formatActor('u1', { name: '  ', email: null })).toBe('Unknown user')
    expect(formatActor('u1', undefined)).toBe('Unknown user')
  })
})

describe('changedFieldsFromSnapshots', () => {
  it('lists top-level keys that differ, ignoring noise', () => {
    const before = { firstName: 'Sam', email: 'a@x.com', updatedAt: '2026-01-01' }
    const after = { firstName: 'Samuel', email: 'a@x.com', updatedAt: '2026-02-02' }
    expect(changedFieldsFromSnapshots(before, after)).toEqual(['firstName'])
  })
  it('is defensive against non-objects', () => {
    expect(changedFieldsFromSnapshots(null, { a: 1 })).toEqual([])
    expect(changedFieldsFromSnapshots('x', 'y')).toEqual([])
  })
})

describe('toAuditActivityRow', () => {
  const actors = new Map<string, AuditActor>([
    ['u1', { name: 'Jamie Rivers', email: 'jamie@studymind.co.uk' }],
  ])

  it('shapes a view row and resolves the actor', () => {
    const row = toAuditActivityRow(
      {
        id: 'a1',
        action: 'contact.viewed',
        actorId: 'u1',
        purpose: 'contact.read',
        before: null,
        after: null,
        occurredAt: new Date('2026-07-24T10:00:00.000Z'),
      },
      actors,
    )
    expect(row).toMatchObject({
      label: 'Viewed',
      category: 'view',
      actorLabel: 'Jamie Rivers',
      changedFields: [],
      occurredAt: '2026-07-24T10:00:00.000Z',
    })
  })

  it('derives changed fields only for updates', () => {
    const row = toAuditActivityRow(
      {
        id: 'a2',
        action: 'contact.updated',
        actorId: 'u1',
        purpose: null,
        before: { firstName: 'Sam', phoneE164: '+447700900001' },
        after: { firstName: 'Sam', phoneE164: '+447700900002' },
        occurredAt: '2026-07-24T10:05:00.000Z',
      },
      actors,
    )
    expect(row.changedFields).toEqual(['phoneE164'])
  })

  it('labels a system write (null actor) as System', () => {
    const row = toAuditActivityRow(
      {
        id: 'a3',
        action: 'contact.updated',
        actorId: null,
        purpose: null,
        before: {},
        after: {},
        occurredAt: '2026-07-24T10:05:00.000Z',
      },
      actors,
    )
    expect(row.actorLabel).toBe('System')
  })
})
