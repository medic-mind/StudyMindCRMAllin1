// Backfill: pull every B2B customer from the invoicing platform and create
// real, editable School / B2B Partner accounts in the CRM (deduped, linked,
// auto-classified). This is what makes the /accounts pages actually populated
// (the user's "get all schools and partners onto the CRM" ask).
//
// Idempotent on every axis:
//   - An InvoicingCustomer mirror row already linked to a BusinessAccount → we
//     reuse that account (update its fields, never create a second).
//   - No link yet but an existing account matches on name + email → adopt it
//     (store the link), never blind-create (the prompt's anti-duplicate rule).
//   - Otherwise create a new account, classify it, and flag low-confidence
//     ones for the Unsorted tray.
//
// Only `b2b` customers become accounts. `b2c` stays Contact-side; `alt_provision`
// is invoicing-only and is skipped here.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { classifyAccount, type AccountKind } from './classify-account'
import { createClientFromConfig, type InvoicingClient } from './client'
import { upsertCustomerFromRecord, upsertInvoiceFromRecord } from './sync'
import { RawCustomer } from './types'

export type DbClient = PrismaClient | Prisma.TransactionClient

export interface ImportAccountsContext {
  actorId: string | null
  requestId: string
}

export interface ImportAccountsResult {
  scanned: number
  created: number
  adopted: number
  updated: number
  needsClassification: number
  pages: number
  /** Invoices pulled from /invoices and mirrored (idempotent on invoicingId). */
  invoicesImported: number
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'account'
  )
}

/** Make a slug unique for a kind by suffixing -2, -3, … on collision. */
async function uniqueSlug(db: DbClient, kind: AccountKind, base: string): Promise<string> {
  let candidate = base
  let n = 1
  // Bounded loop — names rarely collide more than a handful of times.
  while (n < 50) {
    const clash = await db.businessAccount.findFirst({
      where: { kind, slug: candidate },
      select: { id: true },
    })
    if (!clash) return candidate
    n += 1
    candidate = `${base}-${n}`.slice(0, 60)
  }
  return `${base}-${createId().slice(0, 6)}`
}

interface MappedCustomer {
  invoicingId: string
  companyName: string
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  country: string | null
  notes: string | null
}

function mapCustomer(raw: unknown): MappedCustomer | null {
  const parsed = RawCustomer.safeParse(raw)
  if (!parsed.success) return null
  const c = parsed.data
  // Only B2B customers become accounts. b2c is Contact-side; alt_provision is
  // invoicing-only.
  if (c.category && c.category !== 'b2b') return null
  return {
    invoicingId: c.id,
    companyName: c.company_name,
    contactEmail: c.contact_email ?? null,
    contactPhone: c.phone ?? null,
    address: c.address ?? null,
    country: c.country ?? null,
    notes: c.notes ?? null,
  }
}

/**
 * Reconcile one mapped customer into a BusinessAccount. Returns the outcome so
 * the caller can tally. The InvoicingCustomer mirror row is upserted first
 * (so the partner data is always stored), then linked to the account.
 */
async function reconcileOne(
  db: DbClient,
  cust: MappedCustomer,
  ctx: ImportAccountsContext,
): Promise<'created' | 'adopted' | 'updated'> {
  // 1. Ensure the mirror row exists (source 'system' — this is a backfill, not
  //    our own outbound write).
  const mirror = await db.invoicingCustomer.findUnique({
    where: { invoicingId: cust.invoicingId },
    select: { id: true, businessAccountId: true },
  })

  // 2. Already linked → update the account's fields, done.
  if (mirror?.businessAccountId) {
    await db.businessAccount.update({
      where: { id: mirror.businessAccountId },
      data: {
        // Refresh contact coordinates from the platform (source of truth for
        // these), but never clobber a name a human may have corrected.
        contactEmail: cust.contactEmail ?? undefined,
        contactPhone: cust.contactPhone ?? undefined,
        country: cust.country ?? undefined,
        updatedById: ctx.actorId,
      },
    })
    return 'updated'
  }

  // 3. No link yet — try to adopt an existing account before creating one
  //    (anti-duplicate). The platform's B2B customers usually have a null
  //    email, so name is the primary key. Postgres `mode: insensitive` only
  //    folds case, not whitespace — and existing rows may have been stored with
  //    stray spaces — so we fetch the case-insensitive `startsWith` candidate
  //    set and then compare a whitespace-normalised key in JS. Prefer the
  //    OLDEST match so repeated imports converge onto one canonical account
  //    (and pre-existing duplicates get absorbed over time). When an email is
  //    present it must also match.
  const normalizeKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const wantKey = normalizeKey(cust.companyName)
  const candidates = await db.businessAccount.findMany({
    where: {
      archivedAt: null,
      // First word anchors the index-friendly prefix; JS does the exact
      // whitespace-insensitive comparison below.
      name: { startsWith: cust.companyName.trim().split(/\s+/)[0] ?? '', mode: 'insensitive' },
      ...(cust.contactEmail
        ? { contactEmail: { equals: cust.contactEmail, mode: 'insensitive' } }
        : {}),
    },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  const adoptable = candidates.find((c) => normalizeKey(c.name) === wantKey) ?? null
  const normalizedName = cust.companyName.trim().replace(/\s+/g, ' ')

  let accountId: string
  let outcome: 'created' | 'adopted'

  if (adoptable) {
    accountId = adoptable.id
    outcome = 'adopted'
  } else {
    // 4. Create a fresh account, classified.
    const decision = classifyAccount({
      companyName: cust.companyName,
      contactEmail: cust.contactEmail,
    })
    accountId = createId()
    const slug = await uniqueSlug(db, decision.kind, slugify(normalizedName))
    await db.businessAccount.create({
      data: {
        id: accountId,
        kind: decision.kind,
        name: normalizedName,
        slug,
        status: 'active',
        contactEmail: cust.contactEmail,
        contactPhone: cust.contactPhone,
        country: cust.country,
        notes: cust.notes,
        needsClassification: decision.needsClassification,
        classificationReason: decision.reason,
        classificationConfidence: decision.confidence,
        createdById: ctx.actorId,
        updatedById: ctx.actorId,
      },
    })
    outcome = 'created'
    await writeAuditLogEntry(db, {
      actorId: ctx.actorId,
      action: 'business_account.created',
      target: { type: 'BusinessAccount', id: accountId },
      requestId: `${ctx.requestId}:${cust.invoicingId}`,
      after: {
        source: 'invoicing_backfill',
        invoicingId: cust.invoicingId,
        kind: decision.kind,
        needsClassification: decision.needsClassification,
        classificationReason: decision.reason,
      },
    })
  }

  // 5. Link the mirror row to the account (creating the mirror row if the
  //    backfill saw this customer before any webhook did).
  if (mirror) {
    await db.invoicingCustomer.update({
      where: { id: mirror.id },
      data: { businessAccountId: accountId, updatedById: ctx.actorId },
    })
  } else {
    const upserted = await upsertCustomerFromRecord(
      db,
      {
        id: cust.invoicingId,
        company_name: cust.companyName,
        category: 'b2b',
        contact_email: cust.contactEmail,
        phone: cust.contactPhone,
      },
      'system',
    )
    await db.invoicingCustomer.update({
      where: { id: upserted.id },
      data: { businessAccountId: accountId, updatedById: ctx.actorId },
    })
  }

  return outcome
}

export interface ImportAccountsOptions {
  ctx: ImportAccountsContext
  client?: InvoicingClient
  /** Page size for the customers list (max 200 per the API). */
  pageSize?: number
  /** Safety bound on pages walked per run. */
  maxPages?: number
}

/**
 * Walk every B2B customer page and reconcile each into a CRM account. Safe to
 * run repeatedly — re-runs converge (no duplicates).
 */
export async function importBusinessAccountsFromInvoicing(
  db: DbClient,
  opts: ImportAccountsOptions,
): Promise<ImportAccountsResult> {
  const client = opts.client ?? (await createClientFromConfig())
  const pageSize = Math.min(opts.pageSize ?? 200, 200)
  const maxPages = opts.maxPages ?? 100

  const result: ImportAccountsResult = {
    scanned: 0,
    created: 0,
    adopted: 0,
    updated: 0,
    needsClassification: 0,
    pages: 0,
    invoicesImported: 0,
  }

  // Pass 1 — customers → accounts (must run before invoices so an invoice's
  // partner is already mirrored and the FK resolves).
  let page = 1
  while (page <= maxPages) {
    const batch = await client.listCustomers({ category: 'b2b', page, page_size: pageSize })
    if (batch.data.length === 0) break
    result.pages += 1

    for (const raw of batch.data) {
      const cust = mapCustomer(raw)
      if (!cust) continue
      result.scanned += 1
      const outcome = await reconcileOne(db, cust, opts.ctx)
      result[outcome] += 1
    }

    const total = typeof batch.total === 'number' ? batch.total : null
    if (total !== null && page * pageSize >= total) break
    if (batch.data.length < pageSize) break
    page += 1
  }

  // Pass 2 — invoices. The earlier backfill only pulled customers, so historic
  // invoices never landed. Walk /invoices and mirror each through the same
  // idempotent upsert the webhook/reconcile use (dedup on invoicingId, payments
  // deduped on their own id), so this is safe to re-run.
  let invPage = 1
  while (invPage <= maxPages) {
    const batch = await client.listInvoices({ page: invPage, page_size: pageSize })
    if (batch.data.length === 0) break

    for (const raw of batch.data) {
      try {
        await upsertInvoiceFromRecord(db, raw, 'system')
        result.invoicesImported += 1
      } catch {
        // A single malformed invoice shouldn't abort the whole backfill; skip
        // it and keep going (the nightly reconcile will retry from the feed).
      }
    }

    const total = typeof batch.total === 'number' ? batch.total : null
    if (total !== null && invPage * pageSize >= total) break
    if (batch.data.length < pageSize) break
    invPage += 1
  }

  // Tally how many landed in the tray (cheap count, post-import).
  result.needsClassification = await db.businessAccount.count({
    where: { needsClassification: true, archivedAt: null },
  })

  return result
}

export interface ResyncInvoicesResult {
  /** Invoices pulled from the platform and re-applied to the mirror. */
  scanned: number
  pages: number
}

/**
 * Heal pass: re-pull every invoice from the platform and re-apply it through
 * the same idempotent `upsertInvoiceFromRecord` the webhook/reconcile use. Used
 * to retro-fix mirror rows written before a sync bugfix — e.g. paid invoices
 * that were showing their full amount outstanding because a payments-less
 * `invoice.updated` had reset paidMinor to 0. Dedups on invoicingId; safe to
 * run any time. Archived invoices are excluded by the list endpoint, so this
 * never resurrects a deleted one.
 */
export async function resyncInvoicesFromInvoicing(
  db: DbClient,
  opts: { ctx: ImportAccountsContext; client?: InvoicingClient; pageSize?: number; maxPages?: number },
): Promise<ResyncInvoicesResult> {
  const client = opts.client ?? (await createClientFromConfig())
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 100))
  const maxPages = Math.max(1, opts.maxPages ?? 100)

  let page = 1
  let scanned = 0
  while (page <= maxPages) {
    const batch = await client.listInvoices({ page, page_size: pageSize })
    if (batch.data.length === 0) break
    for (const raw of batch.data) {
      try {
        await upsertInvoiceFromRecord(db, raw, 'system')
        scanned += 1
      } catch {
        // One malformed invoice shouldn't abort the whole heal; the nightly
        // reconcile will retry it from the feed.
      }
    }
    const total = typeof batch.total === 'number' ? batch.total : null
    if (total !== null && page * pageSize >= total) break
    if (batch.data.length < pageSize) break
    page += 1
  }

  await writeAuditLogEntry(db, {
    actorId: opts.ctx.actorId,
    action: 'invoicing.invoices_resynced',
    target: { type: 'InvoicingSetting', id: 'default' },
    requestId: opts.ctx.requestId,
    after: { scanned, pages: page },
  })

  return { scanned, pages: page }
}
