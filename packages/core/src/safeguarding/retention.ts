// Safeguarding retention overrides. CLAUDE.md §21 retention table:
//
//   Safeguarding notes: per LA contract (default 25 years from DOB).
//
// LA contracts can override the default upward (almost never downward).
// This module is the single place that computes "is it time to delete this
// safeguarding row?" for the compliance/enforce-retention job.

import type { PrismaClient } from '@prisma/client'

const DEFAULT_SAFEGUARDING_DAYS_FROM_DOB = 25 * 365

export interface EffectiveRetentionInput {
  flagId: string
  /** DOB of the contact the flag belongs to. Null means "unknown" — fall back to default-from-creation. */
  contactDob: Date | null
  /** Default retention (days) configured at the system level. */
  defaultDays: number
  /** Optional per-contract override in days. */
  contractOverrideDays?: number | null
}

export interface EffectiveRetentionResult {
  /** Days from the anchor at which the row is hard-deletable. */
  retentionDays: number
  /** The anchor date — DOB when present (25 years from DOB), else creation. */
  anchor: 'dob' | 'created_at'
}

/**
 * Compute the effective retention for a safeguarding-related row.
 * Pure function — no IO.
 */
export function effectiveRetention(
  input: EffectiveRetentionInput,
): EffectiveRetentionResult {
  const { contactDob, defaultDays, contractOverrideDays } = input

  // LA contract override wins when set.
  if (contractOverrideDays && contractOverrideDays > 0) {
    return {
      retentionDays: contractOverrideDays,
      anchor: contactDob ? 'dob' : 'created_at',
    }
  }

  // No override + DOB known → 25y from DOB (CLAUDE.md §21).
  if (contactDob) {
    return {
      retentionDays: DEFAULT_SAFEGUARDING_DAYS_FROM_DOB,
      anchor: 'dob',
    }
  }

  // Fallback: system default applied from creation.
  return { retentionDays: defaultDays, anchor: 'created_at' }
}

export interface IsExpiredInput extends EffectiveRetentionInput {
  /** Row creation timestamp; used when anchor is 'created_at'. */
  createdAt: Date
  /** "Now" — injectable for tests (CLAUDE.md §30 clock injection). */
  now?: Date
}

export function isExpired(input: IsExpiredInput): boolean {
  const r = effectiveRetention(input)
  const now = input.now ?? new Date()
  const anchor = r.anchor === 'dob' ? input.contactDob! : input.createdAt
  const expiresAt = new Date(anchor.getTime() + r.retentionDays * 24 * 60 * 60 * 1000)
  return now.getTime() >= expiresAt.getTime()
}

// -----------------------------------------------------------------------------
// DB-backed lookup for the retention engine.
// -----------------------------------------------------------------------------

export interface SafeguardingRetentionRow {
  flagId: string
  contactId: string
  contactDob: Date | null
  flagCreatedAt: Date
  contractOverrideDays: number | null
}

/**
 * Walk every active SafeguardingFlag with the data the retention engine
 * needs to compute deletion. Used by compliance/enforce-retention.
 */
export async function listSafeguardingRetentionRows(
  db: PrismaClient,
): Promise<SafeguardingRetentionRow[]> {
  const flags = await db.safeguardingFlag.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      contactId: true,
      createdAt: true,
      contact: {
        select: {
          dateOfBirth: true,
          familyMembers: {
            select: {
              family: {
                select: {
                  // LAContract.contractValue / retention is plumbed via
                  // Family → contract on a future migration; until then,
                  // only system default applies.
                  id: true,
                },
              },
            },
            take: 1,
          },
        },
      },
    },
  })
  return flags.map((f) => ({
    flagId: f.id,
    contactId: f.contactId,
    contactDob: f.contact.dateOfBirth ?? null,
    flagCreatedAt: f.createdAt,
    contractOverrideDays: null,
  }))
}
