import { describe, expect, it } from 'vitest'

import { eraseContactData, ERASED_MARKER } from './erase-contact'

interface Calls {
  contactUpdate: unknown[]
  channelDelete: unknown[]
  bookingDelete: unknown[]
  encryptedDelete: unknown[]
  interactionUpdate: unknown[]
  auditCreate: unknown[]
}

function makeDb(existing: { id: string; erasedAt: Date | null }) {
  const calls: Calls = {
    contactUpdate: [],
    channelDelete: [],
    bookingDelete: [],
    encryptedDelete: [],
    interactionUpdate: [],
    auditCreate: [],
  }
  const tx = {
    contact: {
      findUnique: () => Promise.resolve(existing),
      update: (a: unknown) => {
        calls.contactUpdate.push(a)
        return Promise.resolve({})
      },
    },
    contactChannel: {
      deleteMany: (a: unknown) => {
        calls.channelDelete.push(a)
        return Promise.resolve({ count: 2 })
      },
    },
    contactBookingProfile: {
      deleteMany: (a: unknown) => {
        calls.bookingDelete.push(a)
        return Promise.resolve({ count: 1 })
      },
    },
    encryptedField: {
      deleteMany: (a: unknown) => {
        calls.encryptedDelete.push(a)
        return Promise.resolve({ count: 3 })
      },
    },
    interaction: {
      updateMany: (a: unknown) => {
        calls.interactionUpdate.push(a)
        return Promise.resolve({ count: 5 })
      },
    },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: (a: unknown) => {
        calls.auditCreate.push(a)
        return Promise.resolve({ id: 'audit1' })
      },
    },
  }
  const db = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  }
  return { db: db as never, calls }
}

describe('eraseContactData', () => {
  it('crypto-shreds + anonymises a contact and audits it', async () => {
    const { db, calls } = makeDb({ id: 'c1', erasedAt: null })
    const result = await eraseContactData(db, {
      contactId: 'c1',
      actorId: 'u1',
      reason: 'DSAR erasure request',
    })

    expect(result.erased).toBe(true)
    expect(result.alreadyErased).toBe(false)

    // PII overwritten / nulled + erasure stamped.
    const update = calls.contactUpdate[0] as { data: Record<string, unknown> }
    expect(update.data.firstName).toBe(ERASED_MARKER)
    expect(update.data.email).toBeNull()
    expect(update.data.phoneE164).toBeNull()
    expect(update.data.dateOfBirth).toBeNull()
    expect(update.data.notes).toBeNull()
    expect(update.data.erasedAt).toBeInstanceOf(Date)
    expect(update.data.deletedAt).toBeInstanceOf(Date)
    expect(update.data.erasureScheduledAt).toBeNull()

    // Supplementary PII + encrypted fields destroyed, timeline redacted.
    expect((calls.channelDelete[0] as { where: unknown }).where).toEqual({ contactId: 'c1' })
    expect((calls.bookingDelete[0] as { where: unknown }).where).toEqual({ contactId: 'c1' })
    expect((calls.encryptedDelete[0] as { where: unknown }).where).toEqual({ contactId: 'c1' })
    const redact = calls.interactionUpdate[0] as { data: Record<string, unknown> }
    expect(redact.data.summary).toBe(ERASED_MARKER)
    expect(redact.data.payload).toEqual({})

    // Audit row written.
    const audit = calls.auditCreate[0] as { data: { action: string } }
    expect(audit.data.action).toBe('contact.erased')
  })

  it('is idempotent — a second erase is a no-op', async () => {
    const { db, calls } = makeDb({ id: 'c1', erasedAt: new Date('2026-01-01') })
    const result = await eraseContactData(db, { contactId: 'c1', actorId: 'u1' })
    expect(result.alreadyErased).toBe(true)
    expect(result.erased).toBe(false)
    expect(calls.contactUpdate).toHaveLength(0)
    expect(calls.auditCreate).toHaveLength(0)
  })

  it('throws when the contact does not exist', async () => {
    const { db } = makeDb({ id: 'other', erasedAt: null })
    // findUnique returns the wrong id? Simulate missing by overriding.
    const missingDb = {
      $transaction: (fn: (t: { contact: { findUnique: () => Promise<null> } }) => Promise<unknown>) =>
        fn({ contact: { findUnique: () => Promise.resolve(null) } }),
    }
    void db
    await expect(
      eraseContactData(missingDb as never, { contactId: 'missing', actorId: 'u1' }),
    ).rejects.toThrow(/not found/i)
  })
})
