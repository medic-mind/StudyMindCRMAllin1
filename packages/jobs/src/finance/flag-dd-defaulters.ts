// Direct Debit defaulter flagging (Slice B). Cross-cutting nightly logic that
// recomputes the defaulter set and raises a `direct_debit_default`
// ReconciliationDiscrepancy for any newly-defaulted family. CLAUDE.md §6.3,
// §9, §17.1. Read-only analysis — never auto-charges or auto-duns (§3).
//
// The pure aggregator lives here; the Slack #crm-finops notification glue
// lives at the worker boundary (apps/web/app/api/inngest/_boundary) to avoid a
// jobs → integrations import cycle, mirroring the cost-summary pattern.

import { createHash } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'

import {
  ddIssueMeetsCutoff,
  DEFAULT_DD_ISSUE_CUTOFF,
  listActivePlanArrears,
  listDefaulters,
  listPlanShortfalls,
  type ActivePlanArrearsWithCustomer,
  type DefaulterRow,
  type PlanShortfallWithCustomer,
} from '@studymind/core/finance'
import type { Prisma, PrismaClient } from '@studymind/db'

export type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Stable per-family discrepancy key. Keyed on the family and the sorted reason
 * set so a family whose default reasons change re-surfaces as a fresh
 * discrepancy, but a re-run with no change is a no-op (idempotent on the
 * unique (familyId, category, contextHash) index).
 */
export function defaulterContextHash(row: DefaulterRow): string {
  const h = createHash('sha256')
  h.update(['direct_debit_default', row.familyId, [...row.reasons].sort().join(',')].join('|'))
  return h.digest('hex').slice(0, 32)
}

export interface NewlyDefaulted {
  familyId: string
  billingContactName: string | null
  outstandingMinor: number
  reasons: string[]
}

export interface FlagDefaultersResult {
  scanned: number
  newlyDefaulted: NewlyDefaulted[]
  /** Open defaulter discrepancies auto-resolved because the family recovered. */
  resolved: number
}

/**
 * Recompute the defaulter set and upsert discrepancies. Resolves any open
 * `direct_debit_default` discrepancy for a family that is no longer a defaulter
 * (self-healing, golden rule #4). Returns the families newly flagged this run
 * (so the caller can notify finops).
 */
export async function flagDefaulters(
  db: DbClient,
  now: Date = new Date(),
  cutoff: Date = DEFAULT_DD_ISSUE_CUTOFF,
): Promise<FlagDefaultersResult> {
  // Only surface issues on/after the go-live cutoff (ADR 0045 amendment): a
  // bulk historic import (ADR 0038) drags in long-settled 2020-era failures
  // that would otherwise flood the dashboard. Pre-cutoff families drop out of
  // the set below, so the self-heal resolves any stale discrepancy for them.
  const defaulters = (await listDefaulters(db, { now })).filter((d) =>
    ddIssueMeetsCutoff(d.issueDate, cutoff),
  )
  const newlyDefaulted: NewlyDefaulted[] = []

  for (const row of defaulters) {
    const contextHash = defaulterContextHash(row)
    const existing = await db.reconciliationDiscrepancy.findFirst({
      where: {
        familyId: row.familyId,
        category: 'direct_debit_default',
        contextHash,
      },
      select: { id: true, issueDate: true },
    })
    if (existing) {
      // Backfill the underlying date onto a legacy row so the dashboard cutoff
      // filter is authoritative without re-raising the discrepancy.
      if (existing.issueDate == null && row.issueDate) {
        await db.reconciliationDiscrepancy.update({
          where: { id: existing.id },
          data: { issueDate: row.issueDate },
        })
      }
      continue
    }

    await db.reconciliationDiscrepancy.create({
      data: {
        id: createId(),
        familyId: row.familyId,
        category: 'direct_debit_default',
        summary: `Direct Debit default — ${row.reasons.join(', ')}; outstanding ${row.outstandingMinor}p`,
        payload: {
          reasons: row.reasons,
          mandateStatus: row.mandateStatus,
          failedCount: row.failedCount,
          totalPaidMinor: row.totalPaidMinor,
          totalOwedMinor: row.totalOwedMinor,
          outstandingMinor: row.outstandingMinor,
          billingContactName: row.billingContactName,
        },
        contextHash,
        issueDate: row.issueDate,
      },
    })

    newlyDefaulted.push({
      familyId: row.familyId,
      billingContactName: row.billingContactName,
      outstandingMinor: row.outstandingMinor,
      reasons: row.reasons,
    })
  }

  // Self-heal: resolve open defaulter discrepancies for families no longer in
  // the (cutoff-filtered) defaulter set — recovered OR pre-cutoff historic.
  const defaulterFamilyIds = new Set(defaulters.map((d) => d.familyId))
  const openDefaulters = await db.reconciliationDiscrepancy.findMany({
    where: { category: 'direct_debit_default', resolvedAt: null },
    select: { id: true, familyId: true },
  })
  let resolved = 0
  for (const d of openDefaulters) {
    if (defaulterFamilyIds.has(d.familyId)) continue
    await db.reconciliationDiscrepancy.update({
      where: { id: d.id },
      data: { resolvedAt: now },
    })
    resolved += 1
  }

  return { scanned: defaulters.length, newlyDefaulted, resolved }
}

// -----------------------------------------------------------------------------
// Plan-level issues (ADR 0038, sixth amendment): cancelled-part-way / underpaid
// plans and active plans behind their collection schedule. These complement the
// family-level defaulter scan above. A discrepancy is family-scoped, so we only
// raise one when the plan's GoCardless customer is linked to a Family; unlinked
// plans still surface in the Direct Debits workspace for a human to link.
// Read-only — never auto-charges (§3).
// -----------------------------------------------------------------------------

/** Stable per-plan discrepancy key for a shortfall (terminal — value is stable). */
export function planShortfallContextHash(row: PlanShortfallWithCustomer): string {
  const h = createHash('sha256')
  h.update(['plan_shortfall', row.gcSubscriptionId, [...row.reasons].sort().join(',')].join('|'))
  return h.digest('hex').slice(0, 32)
}

/** Stable per-plan discrepancy key for arrears (one flag per plan; re-arms only
 * after the open discrepancy is resolved, so a worsening plan does not spam). */
export function planArrearsContextHash(row: ActivePlanArrearsWithCustomer): string {
  const h = createHash('sha256')
  h.update(['plan_arrears', row.gcSubscriptionId].join('|'))
  return h.digest('hex').slice(0, 32)
}

export interface NewlyFlaggedPlan {
  gcSubscriptionId: string
  familyId: string
  customerName: string | null
  amountDueMinor: number
  kind: 'shortfall' | 'arrears'
}

export interface FlagPlanIssuesResult {
  shortfallsScanned: number
  arrearsScanned: number
  newlyFlagged: NewlyFlaggedPlan[]
  /** Open plan discrepancies auto-resolved because the plan recovered. */
  resolved: number
}

const PLAN_ISSUE_CATEGORIES = [
  'direct_debit_plan_shortfall',
  'direct_debit_plan_arrears',
] as const

/**
 * Resolve open plan discrepancies whose subscription no longer appears in the
 * current post-cutoff issue set — the system heals itself (golden rule #4) when
 * an arrears plan catches up, a shortfall clears, or a plan falls behind the
 * go-live cutoff (ADR 0045 amendment). Read-only on money.
 *
 * Two sets, because "off the dashboard" and "money came in" are different:
 *  - `postCutoffStillIssue`: still an actionable issue → keep the discrepancy.
 *  - `fullStillIssue`: still an issue at ALL (ignoring the cutoff). A plan
 *    excluded only by the cutoff is NOT recovered, so we must NOT auto-close its
 *    recovery case — only genuinely-recovered plans (absent from the full set)
 *    close their case.
 */
async function resolveRecoveredPlanIssues(
  db: DbClient,
  now: Date,
  postCutoffStillIssue: Set<string>,
  fullStillIssue: Set<string>,
): Promise<number> {
  const open = await db.reconciliationDiscrepancy.findMany({
    where: { category: { in: [...PLAN_ISSUE_CATEGORIES] }, resolvedAt: null },
    select: { id: true, payload: true },
  })
  let resolved = 0
  const recoveredSubIds = new Set<string>()
  for (const d of open) {
    const payload = (d.payload ?? {}) as { gcSubscriptionId?: string }
    const subId = payload.gcSubscriptionId
    if (subId && postCutoffStillIssue.has(subId)) continue
    // Close the recovery case ONLY when the plan is genuinely recovered (gone
    // from the full set), not when it's merely pre-cutoff.
    if (subId && !fullStillIssue.has(subId)) recoveredSubIds.add(subId)
    await db.reconciliationDiscrepancy.update({
      where: { id: d.id },
      data: { resolvedAt: now },
    })
    resolved += 1
  }
  // Auto-clear any open recovery case whose plan has recovered (the money came
  // in). System write — updatedById null (§19); never reopens a written-off
  // case. The Issues tab still allows a manual Record-recovery with amount/ref.
  if (recoveredSubIds.size > 0) {
    await db.directDebitCase.updateMany({
      where: {
        gcSubscriptionId: { in: [...recoveredSubIds] },
        status: { in: ['new', 'chasing', 'escalated'] },
      },
      data: { status: 'recovered', recoveredAt: now, updatedById: null },
    })
  }
  return resolved
}

/**
 * Recompute plan shortfalls + active arrears and upsert a discrepancy for each
 * family-linked plan, idempotent on (familyId, category, contextHash). Resolves
 * any open plan discrepancy whose plan has recovered. Returns the plans newly
 * flagged this run so the caller can notify finops.
 */
export async function flagPlanIssues(
  db: DbClient,
  now: Date = new Date(),
  cutoff: Date = DEFAULT_DD_ISSUE_CUTOFF,
): Promise<FlagPlanIssuesResult> {
  const [allShortfalls, allArrears] = await Promise.all([
    listPlanShortfalls(db),
    listActivePlanArrears(db, { now }),
  ])
  // Only raise/keep discrepancies for post-cutoff plans (ADR 0045 amendment).
  // The full sets are retained so a pre-cutoff plan is not mistaken for one
  // that recovered when we decide whether to auto-close its case.
  const shortfalls = allShortfalls.filter((s) => ddIssueMeetsCutoff(s.issueDate, cutoff))
  const arrears = allArrears.filter((a) => ddIssueMeetsCutoff(a.issueDate, cutoff))
  const newlyFlagged: NewlyFlaggedPlan[] = []

  for (const row of shortfalls) {
    if (!row.familyId) continue
    const contextHash = planShortfallContextHash(row)
    const existing = await db.reconciliationDiscrepancy.findFirst({
      where: { familyId: row.familyId, category: 'direct_debit_plan_shortfall', contextHash },
      select: { id: true, issueDate: true },
    })
    if (existing) {
      if (existing.issueDate == null && row.issueDate) {
        await db.reconciliationDiscrepancy.update({
          where: { id: existing.id },
          data: { issueDate: row.issueDate },
        })
      }
      continue
    }

    await db.reconciliationDiscrepancy.create({
      data: {
        id: createId(),
        familyId: row.familyId,
        category: 'direct_debit_plan_shortfall',
        summary: `Plan ${row.cancelledPartway ? 'cancelled part-way' : 'underpaid'} — ${row.collectedCount}/${row.totalPaymentCount} collected, ${row.shortfallMinor}p still due`,
        payload: {
          gcSubscriptionId: row.gcSubscriptionId,
          name: row.name,
          status: row.status,
          reasons: row.reasons,
          totalPaymentCount: row.totalPaymentCount,
          collectedCount: row.collectedCount,
          expectedTotalMinor: row.expectedTotalMinor,
          collectedMinor: row.collectedMinor,
          shortfallMinor: row.shortfallMinor,
          customerName: row.customerName,
          contactId: row.contactId,
        },
        contextHash,
        issueDate: row.issueDate,
      },
    })
    newlyFlagged.push({
      gcSubscriptionId: row.gcSubscriptionId,
      familyId: row.familyId,
      customerName: row.customerName,
      amountDueMinor: row.shortfallMinor,
      kind: 'shortfall',
    })
  }

  for (const row of arrears) {
    if (!row.familyId) continue
    const contextHash = planArrearsContextHash(row)
    const existing = await db.reconciliationDiscrepancy.findFirst({
      where: { familyId: row.familyId, category: 'direct_debit_plan_arrears', contextHash },
      select: { id: true, issueDate: true },
    })
    if (existing) {
      if (existing.issueDate == null && row.issueDate) {
        await db.reconciliationDiscrepancy.update({
          where: { id: existing.id },
          data: { issueDate: row.issueDate },
        })
      }
      continue
    }

    await db.reconciliationDiscrepancy.create({
      data: {
        id: createId(),
        familyId: row.familyId,
        category: 'direct_debit_plan_arrears',
        summary: `Active plan behind schedule — ${row.collectedCount}/${row.expectedByNow} collected, ~${row.estimatedArrearsMinor}p in arrears`,
        payload: {
          gcSubscriptionId: row.gcSubscriptionId,
          name: row.name,
          missedCount: row.missedCount,
          expectedByNow: row.expectedByNow,
          collectedCount: row.collectedCount,
          estimatedArrearsMinor: row.estimatedArrearsMinor,
          customerName: row.customerName,
          contactId: row.contactId,
        },
        contextHash,
        issueDate: row.issueDate,
      },
    })
    newlyFlagged.push({
      gcSubscriptionId: row.gcSubscriptionId,
      familyId: row.familyId,
      customerName: row.customerName,
      amountDueMinor: row.estimatedArrearsMinor,
      kind: 'arrears',
    })
  }

  // Self-heal: resolve open plan discrepancies whose plan is no longer an issue
  // (recovered or pre-cutoff), closing recovery cases only for truly-recovered
  // plans (present in neither the post-cutoff nor the full set).
  const postCutoffStillIssue = new Set<string>([
    ...shortfalls.map((s) => s.gcSubscriptionId),
    ...arrears.map((a) => a.gcSubscriptionId),
  ])
  const fullStillIssue = new Set<string>([
    ...allShortfalls.map((s) => s.gcSubscriptionId),
    ...allArrears.map((a) => a.gcSubscriptionId),
  ])
  const resolved = await resolveRecoveredPlanIssues(
    db,
    now,
    postCutoffStillIssue,
    fullStillIssue,
  )

  return {
    shortfallsScanned: shortfalls.length,
    arrearsScanned: arrears.length,
    newlyFlagged,
    resolved,
  }
}

// -----------------------------------------------------------------------------
// Auto-populate the recovery worklist (ADR 0045 amendment).
//
// Operators asked that anyone detected to be underpaying, cancelling early, or
// behind on a plan is AUTOMATICALLY added to the recovery list — so no one has
// to remember to "start" a case, and everyone who owes lives in one place until
// a human resolves them. This creates a DirectDebitCase (find-or-create) for
// every post-cutoff issue the detectors above surface: cancelled/underpaid
// plans, plans behind schedule, AND family defaulters — unifying the three
// separate "detected issues" tables into one worklist.
//
// SAFE by construction (§3 — never auto-send): a created case starts with
// auto-send OFF and NO re-signup link, so the engine sends nothing until staff
// arm it (paste the GoCardless/Stripe link, choose the goal, turn reminders on).
// System-authored (createdById null, §19). Idempotent — re-runs never duplicate.
// -----------------------------------------------------------------------------

export interface AutoOpenRecoveryResult {
  plansOpened: number
  defaultersOpened: number
}

const CASE_CLOSED_STATUSES = ['recovered', 'written_off'] as const

export async function autoOpenRecoveryCases(
  db: DbClient,
  now: Date = new Date(),
  cutoff: Date = DEFAULT_DD_ISSUE_CUTOFF,
): Promise<AutoOpenRecoveryResult> {
  let plansOpened = 0
  let defaultersOpened = 0

  // Plan-level issues, keyed on the unique gcSubscriptionId.
  const [shortfalls, arrears] = await Promise.all([
    listPlanShortfalls(db),
    listActivePlanArrears(db, { now }),
  ])
  const planIssues = [
    ...shortfalls
      .filter((s) => ddIssueMeetsCutoff(s.issueDate, cutoff))
      .map((s) => ({
        gcSubscriptionId: s.gcSubscriptionId,
        gcCustomerId: s.gcCustomerId,
        contactId: s.contactId,
        familyId: s.familyId,
        outstandingMinor: s.shortfallMinor,
      })),
    ...arrears
      .filter((a) => ddIssueMeetsCutoff(a.issueDate, cutoff))
      .map((a) => ({
        gcSubscriptionId: a.gcSubscriptionId,
        gcCustomerId: a.gcCustomerId,
        contactId: a.contactId,
        familyId: a.familyId,
        outstandingMinor: a.estimatedArrearsMinor,
      })),
  ]
  const seenSub = new Set<string>()
  for (const p of planIssues) {
    if (seenSub.has(p.gcSubscriptionId)) continue
    seenSub.add(p.gcSubscriptionId)
    const existing = await db.directDebitCase.findUnique({
      where: { gcSubscriptionId: p.gcSubscriptionId },
      select: { id: true },
    })
    if (existing) continue
    const contact = p.contactId
      ? await db.contact.findFirst({
          where: { id: p.contactId, deletedAt: null },
          select: { email: true, phoneE164: true },
        })
      : null
    await db.directDebitCase.create({
      data: {
        id: createId(),
        gcSubscriptionId: p.gcSubscriptionId,
        gcCustomerId: p.gcCustomerId ?? null,
        contactId: p.contactId ?? null,
        familyId: p.familyId ?? null,
        status: 'new',
        openingShortfallMinor: Math.max(0, Math.round(p.outstandingMinor)),
        sendEmails: false,
        sendTexts: false,
        setupLinkUrl: null,
        nextAutoMessageAt: null,
        chaseEmail: contact?.email ?? null,
        chasePhoneE164: contact?.phoneE164 ?? null,
        createdById: null,
        updatedById: null,
      },
    })
    plansOpened += 1
  }

  // Family-level defaulters, keyed on the billing contact (no plan id).
  const defaulters = (await listDefaulters(db, { now })).filter((d) =>
    ddIssueMeetsCutoff(d.issueDate, cutoff),
  )
  for (const d of defaulters) {
    const family = await db.family.findFirst({
      where: { id: d.familyId, deletedAt: null },
      select: { billingContactId: true },
    })
    if (!family?.billingContactId) continue
    const contactId = family.billingContactId
    // Don't spawn a second case for a contact already being worked.
    const existing = await db.directDebitCase.findFirst({
      where: { contactId, status: { notIn: [...CASE_CLOSED_STATUSES] } },
      select: { id: true },
    })
    if (existing) continue
    const [contact, gcCustomer] = await Promise.all([
      db.contact.findFirst({
        where: { id: contactId, deletedAt: null },
        select: { email: true, phoneE164: true },
      }),
      db.gcCustomer.findFirst({ where: { contactId }, select: { gcCustomerId: true } }),
    ])
    await db.directDebitCase.create({
      data: {
        id: createId(),
        gcSubscriptionId: null,
        gcCustomerId: gcCustomer?.gcCustomerId ?? null,
        contactId,
        familyId: d.familyId,
        status: 'new',
        openingShortfallMinor: Math.max(0, Math.round(d.outstandingMinor)),
        sendEmails: false,
        sendTexts: false,
        setupLinkUrl: null,
        nextAutoMessageAt: null,
        chaseEmail: contact?.email ?? null,
        chasePhoneE164: contact?.phoneE164 ?? null,
        createdById: null,
        updatedById: null,
      },
    })
    defaultersOpened += 1
  }

  return { plansOpened, defaultersOpened }
}
