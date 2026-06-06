// Invoicing tRPC router — B2B Invoices Platform (b2b.studymind.co.uk) sync.
//
// Surfaces:
//   invoicing.config.*    — connection status, save key/secret, test (Manager+
//                           reads; CEO/Senior Manager writes secrets).
//   invoicing.customers.* — read mirror customers; ensure-from-account/contact.
//   invoicing.invoices.*  — read mirror invoices; raise / send / recordPayment
//                           / markPaid (Sales Executive+ for raise/send/record;
//                           Manager+ for mark-paid, mirroring finance roles).
//
// All outbound writes are audited inside the integration package; the thin
// procedures here mark ctx.audit.called so the auditedProcedure middleware is
// satisfied (same pattern as forwarding.send / board.callSummary.send).
//
// CLAUDE.md §3 (humans confirm), §20.1 (roles), §27 (tRPC conventions).

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  InvoicingApiError,
  InvoicingReadOnlyError,
  InvoicingUnauthorizedError,
  createClient,
  createClientFromConfig,
  type InvoicingClient,
} from '@studymind/integration-invoicing/client'
import {
  loadInvoicingConfig,
  loadInvoicingConfigStatus,
  saveInvoicingConfig,
} from '@studymind/integration-invoicing/config'
import { importBusinessAccountsFromInvoicing } from '@studymind/integration-invoicing/import-accounts'
import {
  cancelInvoice,
  duplicateInvoice,
  editInvoice,
  ensureCustomerForBusinessAccount,
  ensureCustomerForContact,
  issueInvoice,
  markPaid,
  raiseInvoice,
  recordPayment,
  reissueInvoice,
  removePayment,
  sendInvoice,
  sendReminder,
} from '@studymind/integration-invoicing/outbound'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

// Roles. Reads: Manager+. Secrets: CEO / Senior Manager (settings.write tier).
// Raise/send/record payment: Sales Executive+ (mirrors charge.create_link).
// Mark paid: Manager+ (mirrors charge.refund finance tier).
const READ_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager', 'manager'])
const CONFIG_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager'])
const WRITE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
])
const MARK_PAID_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager', 'manager'])

function assertRead(role: UserRole): void {
  if (!READ_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Manager or above required' })
  }
}
function assertConfig(role: UserRole): void {
  if (!CONFIG_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only CEO or Senior Manager can change invoicing credentials',
    })
  }
}
function assertWrite(role: UserRole): void {
  if (!WRITE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Virtual Assistants cannot raise or send invoices',
    })
  }
}
function assertMarkPaid(role: UserRole): void {
  if (!MARK_PAID_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Manager or above required to mark paid' })
  }
}

/** Map invoicing-platform errors to tRPC error codes with friendly copy. */
function mapApiError(err: unknown): never {
  if (err instanceof InvoicingUnauthorizedError) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'The invoicing API key is missing or invalid (401). Check Settings → Invoicing.',
    })
  }
  if (err instanceof InvoicingReadOnlyError) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The invoicing API key is read-only (403). Ask for a read+write key.',
    })
  }
  if (err instanceof InvoicingApiError) {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `The invoicing platform returned ${err.status}.`,
    })
  }
  // Field-encryption failure: the stored API key can't be decrypted (usually
  // because the encryption key changed between deploys — AUTH_SECRET drift).
  // Surface an actionable message instead of the raw "Failed to unwrap data
  // key", and tell the user the fix (re-save the key; set CRM_LOCAL_ENCRYPTION_KEY).
  const msg = err instanceof Error ? err.message : String(err)
  if (/unwrap data key|envelope authentication|decrypt/i.test(msg)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Could not decrypt the stored invoicing API key — the field-encryption key has ' +
        'changed (this happens when AUTH_SECRET differs between deploys). Fix: in Settings → ' +
        'Invoicing re-paste and Save the API key + webhook secret. To stop it recurring, set a ' +
        'stable CRM_LOCAL_ENCRYPTION_KEY in Railway (web + worker).',
    })
  }
  throw err
}

/** Build a client from the stored (encrypted) config. Throws when unconfigured
 *  or undecryptable; both are mapped to friendly errors by `mapApiError`. */
function clientFromConfigOrThrow(): Promise<InvoicingClient> {
  return createClientFromConfig()
}

const LineItemInput = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive(),
  unitPriceMinor: z.number().int(),
  vatRate: z.number().int().min(0).max(100).optional(),
})

// -----------------------------------------------------------------------------
// config subrouter
// -----------------------------------------------------------------------------

const configRouter = router({
  /** Status for the Settings page: configured?, base URL, last-4 of the key,
   *  cursors. Never returns the secrets themselves. */
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertRead(user.role)
    // Metadata only — never decrypt the stored secrets to render a status
    // badge. A KMS/local-key failure must not 500 the Settings page.
    const cfg = await loadInvoicingConfigStatus()
    const [customerCount, invoiceCount, lastEvent] = await Promise.all([
      ctx.db.invoicingCustomer.count(),
      ctx.db.invoicingInvoice.count(),
      ctx.db.providerEvent.findFirst({
        where: { provider: 'invoicing' },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, type: true },
      }),
    ])
    return {
      baseUrl: cfg.baseUrl,
      configured: cfg.configured,
      webhookSecretConfigured: cfg.webhookSecretConfigured,
      apiKeyLast4: cfg.apiKeyLast4,
      eventsCursor: cfg.eventsCursor,
      streamCursor: cfg.streamCursor,
      customerCount,
      invoiceCount,
      lastEventAt: lastEvent?.receivedAt ?? null,
      lastEventType: lastEvent?.type ?? null,
    }
  }),

  /** Persist base URL / API key / webhook secret. Only supplied fields change;
   *  empty string clears a secret. */
  save: auditedProcedure
    .input(
      z.object({
        baseUrl: z.string().trim().url().optional(),
        apiKey: z.string().trim().optional(),
        webhookSecret: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertConfig(user.role)
      await saveInvoicingConfig({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        webhookSecret: input.webhookSecret,
        actorId: user.id,
        requestId: ctx.requestId,
      })
      // saveInvoicingConfig wrote its own audit row; satisfy the middleware.
      ctx.audit.called = true
      return { ok: true }
    }),

  /** Live connection check: GET /api/v1/ with the stored key. Returns the
   *  platform name/version/scopes so the badge can show "Connected". */
  test: auditedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertConfig(user.role)
    // Decrypting the stored key can fail if the field-encryption backend is
    // misconfigured (e.g. AWS_KMS_KEY_ID set to a placeholder with no real AWS
    // account). Surface that as an actionable BAD_REQUEST rather than a 500
    // that pages on-call (CLAUDE.md §27).
    let cfg
    try {
      cfg = await loadInvoicingConfig()
    } catch {
      await ctx.audit({
        action: 'invoicing.connection_tested',
        target: { type: 'InvoicingSetting', id: 'default' },
        after: { ok: false, reason: 'decrypt_failed' },
      })
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Could not decrypt the stored API key. The field-encryption key is ' +
          'misconfigured — if you are not using AWS, leave AWS_KMS_KEY_ID blank ' +
          'in Railway (it falls back to a local key from AUTH_SECRET), then ' +
          're-save the API key.',
      })
    }
    if (!cfg.apiKey) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No API key configured yet. Paste your sk_live_… key first.',
      })
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })
    let info: { name?: string; version?: string; scopes?: string[] }
    try {
      info = await client.root()
    } catch (err) {
      await ctx.audit({
        action: 'invoicing.connection_tested',
        target: { type: 'InvoicingSetting', id: 'default' },
        after: { ok: false },
      })
      mapApiError(err)
    }
    await ctx.audit({
      action: 'invoicing.connection_tested',
      target: { type: 'InvoicingSetting', id: 'default' },
      after: { ok: true, name: info.name ?? null, version: info.version ?? null },
    })
    return {
      ok: true,
      name: info.name ?? null,
      version: info.version ?? null,
      scopes: info.scopes ?? [],
    }
  }),

  /**
   * Pull all historic B2B customers from the platform into real CRM
   * School / B2B Partner accounts (deduped, auto-classified, tray-flagged when
   * uncertain). Runs INLINE and returns the real counts so the user gets
   * immediate, honest feedback (a queued background job gave no signal when the
   * worker wasn't processing). The import is idempotent — safe to re-run.
   * CEO / Senior Manager only.
   */
  importAccounts: auditedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertConfig(user.role)
    const cfg = await loadInvoicingConfigStatus()
    if (!cfg.configured) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Connect the invoicing API key first.',
      })
    }

    let result
    try {
      result = await importBusinessAccountsFromInvoicing(ctx.db, {
        ctx: { actorId: user.id, requestId: ctx.requestId },
      })
    } catch (err) {
      await ctx.audit({
        action: 'invoicing.accounts_imported',
        target: { type: 'InvoicingSetting', id: 'default' },
        after: { ok: false },
      })
      // Surface the real failure (auth / decrypt / API error) rather than a 500.
      mapApiError(err)
    }

    await ctx.audit({
      action: 'invoicing.accounts_imported',
      target: { type: 'InvoicingSetting', id: 'default' },
      after: result,
    })

    return { ok: true as const, ...result }
  }),
})

// -----------------------------------------------------------------------------
// customers subrouter
// -----------------------------------------------------------------------------

const customersRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          businessAccountId: z.string().optional(),
          contactId: z.string().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertRead(user.role)
      const rows = await ctx.db.invoicingCustomer.findMany({
        where: {
          deletedAt: null,
          ...(input.businessAccountId ? { businessAccountId: input.businessAccountId } : {}),
          ...(input.contactId ? { contactId: input.contactId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: input.limit,
      })
      return rows.map((r) => ({
        id: r.id,
        invoicingId: r.invoicingId,
        companyName: r.companyName,
        category: r.category,
        status: r.status,
        contactEmail: r.contactEmail,
        businessAccountId: r.businessAccountId,
        contactId: r.contactId,
        lastSyncedAt: r.lastSyncedAt,
      }))
    }),
})

// -----------------------------------------------------------------------------
// invoices subrouter — the main outbound flows.
// -----------------------------------------------------------------------------

const invoicesRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          customerId: z.string().optional(),
          businessAccountId: z.string().optional(),
          contactId: z.string().optional(),
          status: z
            .enum(['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled', 'unknown'])
            .optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertRead(user.role)

      // Resolve customer ids from a CRM correlation when given one.
      let customerIds: string[] | undefined
      if (input.businessAccountId || input.contactId) {
        const customers = await ctx.db.invoicingCustomer.findMany({
          where: {
            ...(input.businessAccountId ? { businessAccountId: input.businessAccountId } : {}),
            ...(input.contactId ? { contactId: input.contactId } : {}),
          },
          select: { id: true },
        })
        customerIds = customers.map((c) => c.id)
        if (customerIds.length === 0) return []
      }

      const rows = await ctx.db.invoicingInvoice.findMany({
        where: {
          deletedAt: null,
          ...(input.customerId ? { customerId: input.customerId } : {}),
          ...(customerIds ? { customerId: { in: customerIds } } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { issueDate: 'desc' },
        take: input.limit,
        include: { lineItems: { orderBy: { position: 'asc' } }, payments: true },
      })

      return rows.map((r) => ({
        id: r.id,
        invoicingId: r.invoicingId,
        invoiceNumber: r.invoiceNumber,
        status: r.status,
        clientType: r.clientType,
        currency: r.currency,
        subtotalMinor: r.subtotalMinor,
        vatTotalMinor: r.vatTotalMinor,
        grandTotalMinor: r.grandTotalMinor,
        paidMinor: r.paidMinor,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        poNumber: r.poNumber,
        lastEmailedAt: r.lastEmailedAt,
        customerId: r.customerId,
        lineItems: r.lineItems.map((li) => ({
          id: li.id,
          description: li.description,
          quantity: li.quantity,
          unitPriceMinor: li.unitPriceMinor,
          vatRate: li.vatRate,
        })),
        payments: r.payments.map((p) => ({
          id: p.id,
          invoicingId: p.invoicingId,
          amountMinor: p.amountMinor,
          method: p.method,
          reference: p.reference,
          paidAt: p.paidAt,
        })),
      }))
    }),

  /**
   * Raise an invoice from the CRM. lookup-or-create the customer for the given
   * BusinessAccount (preferred) or Contact, then POST the invoice with line
   * items. Persists the returned id + invoice_number on the mirror rows.
   */
  raise: auditedProcedure
    .input(
      z
        .object({
          businessAccountId: z.string().optional(),
          contactId: z.string().optional(),
          isAlternativeProvision: z.boolean().optional(),
          lineItems: z.array(LineItemInput).min(1).max(100),
          currency: z.string().trim().length(3).optional(),
          clientType: z.enum(['uk_b2b', 'school', 'summer_school', 'international']).optional(),
          pricesIncludeVat: z.boolean().optional(),
          dueDate: z.string().trim().optional(),
          poNumber: z.string().trim().max(120).optional(),
          notes: z.string().trim().max(8000).optional(),
          draft: z.boolean().optional(),
        })
        .refine((v) => Boolean(v.businessAccountId) !== Boolean(v.contactId), {
          message: 'Provide exactly one of businessAccountId or contactId',
          path: ['businessAccountId'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      const outCtx = { actorId: user.id, requestId: ctx.requestId }

      try {
        // 1. lookup-or-create the customer (caches the invoicing id).
        let partnerId: string
        let resolvedClientType = input.clientType
        if (input.businessAccountId) {
          const account = await ctx.db.businessAccount.findUnique({
            where: { id: input.businessAccountId },
          })
          if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
          const ensured = await ensureCustomerForBusinessAccount(ctx.db, {
            businessAccountId: account.id,
            account: {
              kind: account.kind,
              name: account.name,
              contactEmail: account.contactEmail,
              contactPhone: account.contactPhone,
              addressLine1: account.addressLine1,
              addressLine2: account.addressLine2,
              city: account.city,
              postcode: account.postcode,
              country: account.country,
              notes: account.notes,
              isAlternativeProvision: input.isAlternativeProvision,
            },
            ctx: outCtx,
          })
          partnerId = ensured.invoicingId
          if (!resolvedClientType) {
            resolvedClientType = account.kind === 'school' ? 'school' : 'uk_b2b'
          }
        } else {
          const contact = await ctx.db.contact.findFirst({
            where: { id: input.contactId, deletedAt: null },
          })
          if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
          const ensured = await ensureCustomerForContact(ctx.db, {
            contactId: contact.id,
            contact: {
              firstName: contact.firstName,
              lastName: contact.lastName,
              email: contact.email,
              phoneE164: contact.phoneE164,
              addressLine1: contact.addressLine1,
              addressLine2: contact.addressLine2,
              city: contact.city,
              postcode: contact.postcode,
              country: contact.country,
            },
            ctx: outCtx,
          })
          partnerId = ensured.invoicingId
          if (!resolvedClientType) resolvedClientType = 'uk_b2b'
        }

        // 2. raise the invoice.
        const result = await raiseInvoice(ctx.db, {
          partnerId,
          lineItems: input.lineItems,
          currency: input.currency,
          clientType: resolvedClientType,
          pricesIncludeVat: input.pricesIncludeVat,
          dueDate: input.dueDate,
          poNumber: input.poNumber,
          notes: input.notes,
          status: input.draft ? 'draft' : undefined,
          ctx: outCtx,
        })

        ctx.audit.called = true
        return result
      } catch (err) {
        if (err instanceof TRPCError) throw err
        mapApiError(err)
      }
    }),

  send: auditedProcedure
    .input(
      z.object({
        invoicingId: z.string(),
        to: z.string().trim().optional(),
        cc: z.string().trim().optional(),
        subject: z.string().trim().max(300).optional(),
        body: z.string().trim().max(20000).optional(),
        fromEmail: z.string().trim().optional(),
        fromName: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      try {
        const res = await sendInvoice(ctx.db, {
          invoicingId: input.invoicingId,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          body: input.body,
          fromEmail: input.fromEmail,
          fromName: input.fromName,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return res
      } catch (err) {
        mapApiError(err)
      }
    }),

  recordPayment: auditedProcedure
    .input(
      z.object({
        invoicingId: z.string(),
        amountMinor: z.number().int().positive(),
        method: z.string().trim().max(80).optional(),
        reference: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      try {
        await recordPayment(ctx.db, {
          invoicingId: input.invoicingId,
          amountMinor: input.amountMinor,
          method: input.method,
          reference: input.reference,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return { ok: true }
      } catch (err) {
        mapApiError(err)
      }
    }),

  markPaid: auditedProcedure
    .input(z.object({ invoicingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertMarkPaid(user.role)
      try {
        await markPaid(ctx.db, {
          invoicingId: input.invoicingId,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return { ok: true }
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** draft → issued. Sales Executive+. */
  issue: auditedProcedure
    .input(z.object({ invoicingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      try {
        await issueInvoice(ctx.db, {
          invoicingId: input.invoicingId,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return { ok: true }
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** Edit an invoice. `lineItems`, when given, REPLACES every row. Sales Exec+. */
  edit: auditedProcedure
    .input(
      z.object({
        invoicingId: z.string(),
        lineItems: z.array(LineItemInput).min(1).max(100).optional(),
        dueDate: z.string().trim().optional(),
        poNumber: z.string().trim().max(120).optional(),
        notes: z.string().trim().max(8000).optional(),
        internalNotes: z.string().trim().max(8000).optional(),
        clientType: z.enum(['uk_b2b', 'school', 'summer_school', 'international']).optional(),
        pricesIncludeVat: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      try {
        await editInvoice(ctx.db, {
          invoicingId: input.invoicingId,
          lineItems: input.lineItems,
          dueDate: input.dueDate,
          poNumber: input.poNumber,
          notes: input.notes,
          internalNotes: input.internalNotes,
          clientType: input.clientType,
          pricesIncludeVat: input.pricesIncludeVat,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return { ok: true }
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** Send a "still unpaid" reminder with the PDF re-attached. Sales Exec+. */
  sendReminder: auditedProcedure
    .input(
      z.object({
        invoicingId: z.string(),
        to: z.string().trim().optional(),
        cc: z.string().trim().optional(),
        subject: z.string().trim().max(300).optional(),
        body: z.string().trim().max(20000).optional(),
        attachPdf: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      try {
        const res = await sendReminder(ctx.db, {
          invoicingId: input.invoicingId,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          body: input.body,
          attachPdf: input.attachPdf,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return res
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** Reissue with a fresh issue/due date. Sales Exec+. */
  reissue: auditedProcedure
    .input(z.object({ invoicingId: z.string(), issueDate: z.string().trim().optional() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      try {
        await reissueInvoice(ctx.db, {
          invoicingId: input.invoicingId,
          issueDate: input.issueDate,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return { ok: true }
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** Duplicate → new DRAFT copy with a new number. Sales Exec+. */
  duplicate: auditedProcedure
    .input(z.object({ invoicingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertWrite(user.role)
      try {
        const res = await duplicateInvoice(ctx.db, {
          invoicingId: input.invoicingId,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return res
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** Void an invoice (status → cancelled). Manager+ (finance tier). */
  cancel: auditedProcedure
    .input(z.object({ invoicingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertMarkPaid(user.role)
      try {
        await cancelInvoice(ctx.db, {
          invoicingId: input.invoicingId,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return { ok: true }
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** Remove a recorded payment. Manager+ (finance tier — undoes money state). */
  removePayment: auditedProcedure
    .input(z.object({ invoicingId: z.string(), paymentInvoicingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertMarkPaid(user.role)
      try {
        await removePayment(ctx.db, {
          invoicingId: input.invoicingId,
          paymentInvoicingId: input.paymentInvoicingId,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        ctx.audit.called = true
        return { ok: true }
      } catch (err) {
        mapApiError(err)
      }
    }),

  /** The platform's activity timeline for an invoice. Manager+ read. */
  activity: protectedProcedure
    .input(z.object({ invoicingId: z.string() }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertRead(user.role)
      try {
        const client = await clientFromConfigOrThrow()
        const rows = await client.getInvoiceActivity(input.invoicingId)
        return rows.map((r) => ({
          id: r.id != null ? String(r.id) : null,
          type: r.type ?? r.action ?? null,
          message: r.message ?? r.description ?? null,
          source: r.source ?? null,
          actor: r.actor ?? null,
          createdAt: r.created_at ?? null,
        }))
      } catch (err) {
        mapApiError(err)
      }
    }),
})

// -----------------------------------------------------------------------------
// reference subrouter — billing companies / bank accounts / company settings.
// Read-only data used to pick the letterhead + bank details when raising an
// invoice. Manager+ (same tier as the other reads).
// -----------------------------------------------------------------------------

const referenceRouter = router({
  billingCompanies: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertRead(user.role)
    try {
      const client = await clientFromConfigOrThrow()
      const rows = await client.getBillingCompanies()
      return rows.map((r) => ({
        id: r.id,
        name: r.name ?? null,
        vatNumber: r.vat_number ?? null,
        prefix: r.prefix ?? null,
        isDefault: r.is_default ?? false,
      }))
    } catch (err) {
      mapApiError(err)
    }
  }),

  bankAccounts: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertRead(user.role)
    try {
      const client = await clientFromConfigOrThrow()
      const rows = await client.getBankAccounts()
      return rows.map((r) => ({
        id: r.id,
        name: r.name ?? null,
        sortCode: r.sort_code ?? null,
        iban: r.iban ?? null,
        isDefault: r.is_default ?? false,
      }))
    } catch (err) {
      mapApiError(err)
    }
  }),

  companySettings: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertRead(user.role)
    try {
      const client = await clientFromConfigOrThrow()
      return await client.getCompanySettings()
    } catch (err) {
      mapApiError(err)
    }
  }),
})

export const invoicingRouter = router({
  config: configRouter,
  customers: customersRouter,
  invoices: invoicesRouter,
  reference: referenceRouter,
})
