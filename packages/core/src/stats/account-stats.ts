// Per-account engagement aggregates for the B2B Accounts list (schools +
// partnerships). CLAUDE.md §27 (list view-models pre-shaped on the server).
//
// An account has no timeline of its own; its activity is the union of the
// contacts linked to it (BusinessAccountContact). Students + hours come from
// the BusinessAccountStudent cohort table; "amount paid" comes from paid
// UploadedInvoice rows attached to the account. Batched by accountId so the
// whole list costs a fixed handful of queries.

import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export interface AccountStats {
  studentCount: number
  hoursContracted: number
  hoursDelivered: number
  amountPaidMinor: number
  callCount: number
  textCount: number
  emailCount: number
  lastContactedAt: Date | null
}

function zero(): AccountStats {
  return {
    studentCount: 0,
    hoursContracted: 0,
    hoursDelivered: 0,
    amountPaidMinor: 0,
    callCount: 0,
    textCount: 0,
    emailCount: 0,
    lastContactedAt: null,
  }
}

const EMAIL_TYPES = ['email', 'email_received', 'email_sent'] as const

export async function loadAccountStats(
  db: Db,
  accountIds: string[],
): Promise<Map<string, AccountStats>> {
  const out = new Map<string, AccountStats>()
  if (accountIds.length === 0) return out
  for (const id of accountIds) out.set(id, zero())

  // 1 — Students + contracted/delivered hours, per account.
  const students = await db.businessAccountStudent.groupBy({
    by: ['accountId'],
    where: { accountId: { in: accountIds }, archivedAt: null },
    _count: { _all: true },
    _sum: { hoursContracted: true, hoursDelivered: true },
  })
  for (const s of students) {
    const e = out.get(s.accountId)
    if (!e) continue
    e.studentCount = s._count._all
    e.hoursContracted = s._sum.hoursContracted ?? 0
    e.hoursDelivered = s._sum.hoursDelivered ?? 0
  }

  // 2 — Paid invoices attached to the account (the honest B2B "spend").
  const invoices = await db.uploadedInvoice.groupBy({
    by: ['businessAccountId'],
    where: {
      businessAccountId: { in: accountIds },
      status: 'paid',
      archivedAt: null,
    },
    _sum: { amountMinor: true },
  })
  for (const inv of invoices) {
    if (!inv.businessAccountId) continue
    const e = out.get(inv.businessAccountId)
    if (!e) continue
    e.amountPaidMinor = inv._sum.amountMinor ?? 0
  }

  // 3 — Linked contacts → account membership map.
  const links = await db.businessAccountContact.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, contactId: true },
  })
  if (links.length === 0) return out

  const accountsByContact = new Map<string, string[]>()
  const contactIdSet = new Set<string>()
  for (const l of links) {
    contactIdSet.add(l.contactId)
    const list = accountsByContact.get(l.contactId) ?? []
    list.push(l.accountId)
    accountsByContact.set(l.contactId, list)
  }
  const contactIds = Array.from(contactIdSet)

  // 4 — Comms counts across the linked contacts' timelines.
  const groups = await db.interaction.groupBy({
    by: ['contactId', 'type'],
    where: {
      contactId: { in: contactIds },
      deletedAt: null,
      type: { in: ['call', 'message', ...EMAIL_TYPES] },
    },
    _count: { _all: true },
  })
  for (const row of groups) {
    if (!row.contactId) continue
    const accountIdsForContact = accountsByContact.get(row.contactId) ?? []
    const n = row._count._all
    for (const accId of accountIdsForContact) {
      const e = out.get(accId)
      if (!e) continue
      if (row.type === 'call') e.callCount += n
      else if (row.type === 'message') e.textCount += n
      else e.emailCount += n
    }
  }

  // 5 — Last contacted = newest interaction across the linked contacts.
  const lastByContact = await db.interaction.groupBy({
    by: ['contactId'],
    where: { contactId: { in: contactIds }, deletedAt: null },
    _max: { occurredAt: true },
  })
  for (const row of lastByContact) {
    if (!row.contactId) continue
    const at = row._max.occurredAt
    if (!at) continue
    for (const accId of accountsByContact.get(row.contactId) ?? []) {
      const e = out.get(accId)
      if (!e) continue
      if (!e.lastContactedAt || at > e.lastContactedAt) e.lastContactedAt = at
    }
  }

  return out
}
