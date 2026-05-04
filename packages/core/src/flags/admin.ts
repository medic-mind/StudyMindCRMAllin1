// Feature flag admin mutations. See CLAUDE.md §31.
//
// This module is the ONLY path that mutates FeatureFlag rows. UI must never
// write to the table directly — every toggle writes both the row update and
// a `flag.toggled` AuditLogEntry inside one transaction.

import type { Prisma, PrismaClient } from '@prisma/client'
import { withAudit } from '@studymind/audit'

import { clearFlagCache } from './index'
import { FLAGS, type FlagName, isFlagName } from './registry'

export interface SetFlagInput {
  name: FlagName
  enabled: boolean
  actorId: string
  reason: string
  requestId?: string
}

export interface SetFlagResult {
  name: FlagName
  before: boolean
  after: boolean
  auditEntryId: string
}

/**
 * Toggle a flag at runtime. Writes the FeatureFlag row and a `flag.toggled`
 * audit entry in the same transaction; if either fails the whole change is
 * rolled back. Clears the in-memory resolution cache so callers see the new
 * value within the local process immediately (other processes converge
 * within the cache TTL).
 */
export async function setFlag(
  db: PrismaClient,
  input: SetFlagInput,
): Promise<SetFlagResult> {
  const { name, enabled, actorId, reason, requestId } = input

  if (!isFlagName(name)) {
    throw new Error('UNKNOWN_FLAG: ' + String(name))
  }
  if (!reason || reason.trim().length === 0) {
    throw new Error('REASON_REQUIRED')
  }

  const meta = FLAGS[name]

  return withAudit(db, { actorId, requestId }, async (tx, helpers) => {
    const existing = await tx.featureFlag.findUnique({
      where: { key: name },
      select: { enabled: true },
    })
    const before = existing?.enabled ?? meta.default

    const data: Prisma.FeatureFlagUpsertArgs['create'] = {
      id: name,
      key: name,
      enabled,
      description: meta.description,
    }
    await tx.featureFlag.upsert({
      where: { key: name },
      create: { ...data, createdById: actorId, updatedById: actorId },
      update: { enabled, updatedById: actorId },
    })

    const auditEntryId = await helpers.audit({
      action: 'flag.toggled',
      target: { type: 'FeatureFlag', id: name },
      before: { enabled: before },
      after: { enabled, reason },
      purpose: reason,
    })

    clearFlagCache()
    return { name, before, after: enabled, auditEntryId }
  })
}
