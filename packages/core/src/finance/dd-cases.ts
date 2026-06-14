// Direct Debit recovery cases (ADR 0038, seventh amendment). The workflow an
// agent drives to recover a cancelled/underpaid plan's shortfall: status,
// owner, and how it was recovered. Read/write CRM state — never charges or
// sends anything itself (CLAUDE.md §3); all outbound is human-confirmed and
// lives elsewhere. Money in integer minor units (§19).
//
// Soft links (gcSubscriptionId / contactId / familyId / ownerUserId) are plain
// columns JS-joined on demand, matching the GC mirror (ADR 0038) so a case
// never trips on import ordering.

import { createId } from '@paralleldrive/cuid2'

import type { Prisma, PrismaClient } from '@prisma/client'

export type DbClient = PrismaClient | Prisma.TransactionClient

export type DirectDebitCaseStatusValue =
  | 'new'
  | 'chasing'
  | 'escalated'
  | 'recovered'
  | 'written_off'

export const DD_CASE_STATUSES: DirectDebitCaseStatusValue[] = [
  'new',
  'chasing',
  'escalated',
  'recovered',
  'written_off',
]

/** Terminal statuses — a case that is closed. */
const CLOSED_STATUSES = new Set<DirectDebitCaseStatusValue>(['recovered', 'written_off'])

/**
 * Allowed status transitions. The flow is new → chasing → escalated, with
 * recovered / written_off reachable from any open state, and a closed case
 * reopenable back to chasing. Pure + table-driven so it is unit-testable and
 * the UI can grey out illegal moves.
 */
const TRANSITIONS: Record<DirectDebitCaseStatusValue, DirectDebitCaseStatusValue[]> = {
  new: ['chasing', 'escalated', 'recovered', 'written_off'],
  chasing: ['escalated', 'recovered', 'written_off'],
  escalated: ['chasing', 'recovered', 'written_off'],
  recovered: ['chasing'],
  written_off: ['chasing'],
}

export function canTransition(
  from: DirectDebitCaseStatusValue,
  to: DirectDebitCaseStatusValue,
): boolean {
  if (from === to) return false
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function isClosedStatus(status: DirectDebitCaseStatusValue): boolean {
  return CLOSED_STATUSES.has(status)
}

export interface DirectDebitCaseRow {
  id: string
  gcSubscriptionId: string
  gcCustomerId: string | null
  contactId: string | null
  familyId: string | null
  status: DirectDebitCaseStatusValue
  ownerUserId: string | null
  openingShortfallMinor: number
  recoveredMinor: number
  recoveredAt: Date | null
  recoveryMethod: string | null
  recoveryRef: string | null
  notes: string | null
  updatedAt: Date
}

export interface UpsertCaseInput {
  gcSubscriptionId: string
  gcCustomerId?: string | null
  contactId?: string | null
  familyId?: string | null
  openingShortfallMinor?: number
  actorId: string
}

/**
 * Get the case for a plan, creating it (status `new`) on first touch. The
 * links + opening shortfall are filled on create and left alone afterwards.
 */
export async function getOrCreateCase(
  db: DbClient,
  input: UpsertCaseInput,
): Promise<DirectDebitCaseRow> {
  const existing = await db.directDebitCase.findUnique({
    where: { gcSubscriptionId: input.gcSubscriptionId },
  })
  if (existing) return existing as unknown as DirectDebitCaseRow

  const created = await db.directDebitCase.create({
    data: {
      id: createId(),
      gcSubscriptionId: input.gcSubscriptionId,
      gcCustomerId: input.gcCustomerId ?? null,
      contactId: input.contactId ?? null,
      familyId: input.familyId ?? null,
      openingShortfallMinor: input.openingShortfallMinor ?? 0,
      status: 'new',
      createdById: input.actorId,
      updatedById: input.actorId,
    },
  })
  return created as unknown as DirectDebitCaseRow
}

export class CaseTransitionError extends Error {
  constructor(
    public readonly from: DirectDebitCaseStatusValue,
    public readonly to: DirectDebitCaseStatusValue,
  ) {
    super(`Illegal Direct Debit case transition: ${from} → ${to}`)
    this.name = 'CaseTransitionError'
  }
}

/** Change a case's status (validating the transition). */
export async function setCaseStatus(
  db: DbClient,
  input: {
    gcSubscriptionId: string
    to: DirectDebitCaseStatusValue
    actorId: string
    links?: Omit<UpsertCaseInput, 'gcSubscriptionId' | 'actorId'>
  },
): Promise<{ from: DirectDebitCaseStatusValue; case: DirectDebitCaseRow }> {
  const current = await getOrCreateCase(db, {
    gcSubscriptionId: input.gcSubscriptionId,
    actorId: input.actorId,
    ...input.links,
  })
  if (!canTransition(current.status, input.to)) {
    throw new CaseTransitionError(current.status, input.to)
  }
  const updated = await db.directDebitCase.update({
    where: { id: current.id },
    data: { status: input.to, updatedById: input.actorId },
  })
  return { from: current.status, case: updated as unknown as DirectDebitCaseRow }
}

/** Assign (or clear) the case owner. */
export async function assignCase(
  db: DbClient,
  input: {
    gcSubscriptionId: string
    ownerUserId: string | null
    actorId: string
    links?: Omit<UpsertCaseInput, 'gcSubscriptionId' | 'actorId'>
  },
): Promise<DirectDebitCaseRow> {
  const current = await getOrCreateCase(db, {
    gcSubscriptionId: input.gcSubscriptionId,
    actorId: input.actorId,
    ...input.links,
  })
  const updated = await db.directDebitCase.update({
    where: { id: current.id },
    data: { ownerUserId: input.ownerUserId, updatedById: input.actorId },
  })
  return updated as unknown as DirectDebitCaseRow
}

/** Save a free-text note on the case. */
export async function setCaseNotes(
  db: DbClient,
  input: {
    gcSubscriptionId: string
    notes: string | null
    actorId: string
    links?: Omit<UpsertCaseInput, 'gcSubscriptionId' | 'actorId'>
  },
): Promise<DirectDebitCaseRow> {
  const current = await getOrCreateCase(db, {
    gcSubscriptionId: input.gcSubscriptionId,
    actorId: input.actorId,
    ...input.links,
  })
  const updated = await db.directDebitCase.update({
    where: { id: current.id },
    data: { notes: input.notes, updatedById: input.actorId },
  })
  return updated as unknown as DirectDebitCaseRow
}

/**
 * Fetch the cases for a set of plans, keyed by gcSubscriptionId, for hydrating
 * the Issues tab / contact panel. Read-only.
 */
export async function getCasesForSubscriptions(
  db: DbClient,
  gcSubscriptionIds: string[],
): Promise<Map<string, DirectDebitCaseRow>> {
  const ids = Array.from(new Set(gcSubscriptionIds.filter((id) => id.length > 0)))
  if (ids.length === 0) return new Map()
  const rows = await db.directDebitCase.findMany({
    where: { gcSubscriptionId: { in: ids }, deletedAt: null },
  })
  const map = new Map<string, DirectDebitCaseRow>()
  for (const r of rows) map.set(r.gcSubscriptionId, r as unknown as DirectDebitCaseRow)
  return map
}
