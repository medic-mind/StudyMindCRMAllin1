// Forwarding rule CRUD helpers. Thin wrappers over Prisma so the tRPC
// router stays focused on auth + audit. CLAUDE.md §27.

import type { Prisma, PrismaClient } from '@prisma/client'

import { BusinessError } from '../errors'

import type { ForwardingRuleSummary } from './types'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Reads all rules. `includeArchived` defaults to false so the contact-page
 * dropdown only sees live rules; the admin UI passes true to manage the
 * archive.
 */
export async function listRules(
  db: Db,
  opts: { includeArchived?: boolean } = {},
): Promise<ForwardingRuleSummary[]> {
  const rows = await db.forwardingRule.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
  })
  return rows.map(toSummary)
}

export async function getRule(db: Db, id: string): Promise<ForwardingRuleSummary> {
  const row = await db.forwardingRule.findUnique({ where: { id } })
  if (!row) throw new BusinessError('FORWARDING_RULE_NOT_FOUND', 'Forwarding rule not found')
  return toSummary(row)
}

export async function getRuleByKey(db: Db, key: string): Promise<ForwardingRuleSummary | null> {
  const row = await db.forwardingRule.findUnique({ where: { key } })
  return row ? toSummary(row) : null
}

function toSummary(row: {
  id: string
  key: string
  label: string
  description: string | null
  toAddresses: string[]
  ccAddresses: string[]
  bccAddresses: string[]
  subjectTemplate: string
  bodyTemplate: string
  sortOrder: number
  archivedAt: Date | null
}): ForwardingRuleSummary {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    description: row.description,
    toAddresses: row.toAddresses,
    ccAddresses: row.ccAddresses,
    bccAddresses: row.bccAddresses,
    subjectTemplate: row.subjectTemplate,
    bodyTemplate: row.bodyTemplate,
    sortOrder: row.sortOrder,
    archived: row.archivedAt != null,
  }
}
