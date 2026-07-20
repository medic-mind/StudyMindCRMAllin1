// Inngest functions triggered after a Stripe webhook lands.
// CLAUDE.md §7.1 (handler stays thin), §8 (refetch — webhook payloads are
// notifications, not state), §17 (concurrency, granular step.run, idempotency).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import {
  buildProductClassificationPrompt,
  productClassificationSchema,
  runStructured,
} from '@studymind/ai'
import { detectCampPurchase } from '@studymind/core/camp'
import {
  classifyProductFromText,
  recomputeAtRiskForFamily,
  recordUnresolvedStripePayment,
  resolveAiProductSuggestion,
  resolveFamilyByStripeCustomer,
  revertStripePayment,
  syncStripeInvoice,
  syncStripePayment,
  syncStripeSubscription,
  type ProductCatalogueEntry,
} from '@studymind/core/finance'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient } from './client'
import { mapSubscriptionState } from './types'

// Event types we currently process. Anything else is logged and skipped (no
// error) so unrecognised webhook types do not blow up the dead-letter queue.
const HANDLED_TYPES = new Set<string>([
  'invoice.payment_failed',
  'customer.subscription.updated',
  // Successful card payment + its reversal. The charge id is the canonical,
  // de-duplicated money-movement id (Payment.externalId). We record payments
  // off charges only — not invoice/payment_intent — so a single payment is
  // never double-counted across overlapping event types.
  'charge.succeeded',
  'charge.refunded',
])

/** Active product catalogue, fed to the deterministic product classifier. */
async function loadProductCatalogue(): Promise<ProductCatalogueEntry[]> {
  const items = await db.productCatalogueItem.findMany({
    where: { active: true },
    select: { handle: true, name: true, category: true, aliases: true },
  })
  return items
}

/** Build the text we classify a charge against (description + metadata). */
function chargeProductText(charge: {
  description?: string | null
  statement_descriptor?: string | null
  metadata?: Record<string, string> | null
}): string {
  return [
    charge.description ?? '',
    charge.statement_descriptor ?? '',
    ...Object.values(charge.metadata ?? {}),
  ]
    .filter(Boolean)
    .join(' ')
}

interface StripeEventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

export const stripeEventReceived = inngest.createFunction(
  {
    id: 'stripe/event.received',
    name: 'Process Stripe webhook event',
    concurrency: { limit: 5 },
    retries: 6,
  },
  { event: 'stripe/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as StripeEventReceivedData
    const { eventId, type } = data

    if (!HANDLED_TYPES.has(type)) {
      logger.info({ eventId, type }, 'stripe event type not handled — skipping')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: data.providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'type_not_handled' }
    }

    // 1. Refetch the canonical object from Stripe. Webhook payloads are
    //    notifications; we never trust them for state. CLAUDE.md §8.
    const refetched = await step.run('refetch', async () => {
      const stripe = createClient()
      const fresh = await stripe.events.retrieve(eventId)
      return fresh
    })

    // 2. Persist into our normalised mirror tables. The mapper is keyed on
    //    Stripe object ids so retries are safe.
    const persisted = await step.run('persist', async () => {
      // Successful charge → record the Payment against the resolved Family and
      // classify the purchased product against the catalogue (no duplication).
      if (refetched.type === 'charge.succeeded') {
        const charge = refetched.data.object as {
          id: string
          customer: string | { id: string } | null
          amount: number
          currency: string
          created: number
          invoice: string | { id: string } | null
          payment_intent?: string | { id: string } | null
          description?: string | null
          statement_descriptor?: string | null
          metadata?: Record<string, string> | null
          billing_details?: { email?: string | null; name?: string | null } | null
        }
        const customerId =
          typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? '')
        const invoiceId =
          typeof charge.invoice === 'string' ? charge.invoice : (charge.invoice?.id ?? null)
        const result = await syncStripePayment(db, {
          stripeChargeId: charge.id,
          stripeCustomerId: customerId,
          amountMinor: charge.amount,
          currency: charge.currency.toUpperCase(),
          receivedAt: new Date(charge.created * 1000),
          stripeInvoiceId: invoiceId,
        })
        // Classify regardless so an unresolved payment still carries the product
        // hint in the finance tray.
        const classification = classifyProductFromText(
          chargeProductText(charge),
          await loadProductCatalogue(),
        )
        const productText = chargeProductText(charge)
        return {
          kind: 'payment' as const,
          stripeId: charge.id,
          stripeCustomerId: customerId,
          stripePaymentIntentId:
            typeof charge.payment_intent === 'string'
              ? charge.payment_intent
              : (charge.payment_intent?.id ?? null),
          amountMinor: charge.amount,
          currency: charge.currency.toUpperCase(),
          receivedAt: new Date(charge.created * 1000),
          customerEmail: charge.billing_details?.email ?? null,
          customerName: charge.billing_details?.name ?? null,
          description: charge.description ?? null,
          productText,
          // Summer Camp / Work Experience purchase detection (CLAUDE.md §37).
          campPurchase: detectCampPurchase(productText),
          classification,
          ...result,
        }
      }

      // Refunded charge → mark the mirrored Payment reverted (idempotent).
      if (refetched.type === 'charge.refunded') {
        const charge = refetched.data.object as {
          id: string
          customer: string | { id: string } | null
        }
        const customerId =
          typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? '')
        const result = await revertStripePayment(db, {
          stripeChargeId: charge.id,
          revertedAt: new Date(),
        })
        return {
          kind: 'payment_refund' as const,
          stripeId: charge.id,
          stripeCustomerId: customerId,
          classification: null,
          // `missing` (refund before we saw the charge) is surfaced like an
          // unresolved customer rather than silently dropped.
          unresolved: result.missing,
          familyId: result.familyId,
        }
      }

      if (refetched.type === 'customer.subscription.updated') {
        const sub = refetched.data.object as {
          id: string
          customer: string | { id: string }
          status: string
          current_period_end: number | null
        }
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
        const result = await syncStripeSubscription(db, {
          stripeId: sub.id,
          stripeCustomerId: customerId,
          state: mapSubscriptionState(sub.status),
          currentPeriodEnd: sub.current_period_end
            ? new Date(sub.current_period_end * 1000)
            : null,
        })
        return {
          kind: 'subscription' as const,
          stripeId: sub.id,
          stripeCustomerId: customerId,
          ...result,
        }
      }

      // invoice.payment_failed
      const inv = refetched.data.object as {
        id: string
        customer: string | { id: string }
        amount_due: number
        currency: string
        created: number
        due_date: number | null
      }
      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer.id
      const result = await syncStripeInvoice(db, {
        stripeInvoiceId: inv.id,
        stripeCustomerId: customerId,
        amountDueMinor: inv.amount_due,
        currency: inv.currency.toUpperCase(),
        issuedAt: new Date(inv.created * 1000),
        dueAt: inv.due_date ? new Date(inv.due_date * 1000) : null,
      })
      return {
        kind: 'invoice' as const,
        stripeId: inv.id,
        stripeCustomerId: customerId,
        ...result,
      }
    })

    if (persisted.unresolved) {
      // No Family connected to this Stripe customer. Surface and stop —
      // CLAUDE.md §3 forbids silent drops. Finance picks this up manually.
      logger.warn(
        { eventId, type, stripeCustomerId: persisted.stripeCustomerId },
        'no Family linked to Stripe customer — skipping persist',
      )
      await step.run('mark-unresolved', async () => {
        // A successful charge with no Family mapping lands in the finance tray
        // for a human to link or dismiss (ADR 0030 follow-up). Refunds for an
        // unseen charge have nothing to surface.
        if (persisted.kind === 'payment') {
          const recorded = await recordUnresolvedStripePayment(db, {
            stripeChargeId: persisted.stripeId,
            stripeCustomerId: persisted.stripeCustomerId,
            amountMinor: persisted.amountMinor,
            currency: persisted.currency,
            // step.run output is JSON-serialised, so Date round-trips as a string.
            receivedAt: new Date(persisted.receivedAt),
            customerEmail: persisted.customerEmail,
            customerName: persisted.customerName,
            description: persisted.description,
            productHandles: persisted.classification?.productHandles ?? [],
          })
          if (recorded.created) {
            await writeAuditLogEntry(db, {
              actorId: null,
              action: 'stripe.payment_unresolved',
              target: { type: 'UnresolvedStripePayment', id: recorded.id },
              requestId: eventId,
              after: {
                stripeChargeId: persisted.stripeId,
                stripeCustomerId: persisted.stripeCustomerId,
                amountMinor: persisted.amountMinor,
              },
            })
          }
        }
        await db.providerEvent.update({
          where: { id: data.providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'unresolved_customer' }
    }

    // 2b. Advisory AI product classification — runs ONLY when the deterministic
    //     catalogue matcher found nothing, for a resolved card payment. The
    //     model picks one EXISTING catalogue handle (or null), so it can never
    //     create a duplicate product. Degrades to null on any error or missing
    //     key — never fails payment processing (ADR 0030, CLAUDE.md §32).
    const aiProduct = await step.run('ai-classify-product', async () => {
      if (persisted.kind !== 'payment') return null
      const cls = 'classification' in persisted ? persisted.classification : null
      if (!cls || !cls.unmatched) return null
      if (!process.env['OPENAI_API_KEY'] && !process.env['GEMINI_API_KEY']) return null
      const description = persisted.description ?? ''
      if (description.trim().length === 0) return null
      const catalogue = (await loadProductCatalogue()).map((c) => ({
        handle: c.handle,
        name: c.name,
        category: c.category,
      }))
      if (catalogue.length === 0) return null
      try {
        const prompt = buildProductClassificationPrompt({
          description,
          amountMinor: persisted.amountMinor,
          currency: persisted.currency,
          catalogue,
        })
        const out = await runStructured({
          task: 'product_classification',
          promptVersion: prompt.promptVersion,
          schema: productClassificationSchema,
          schemaName: 'product_classification',
          system: prompt.system,
          user: prompt.user,
          ctx: { eventId },
        })
        return resolveAiProductSuggestion(
          out,
          catalogue.map((c) => c.handle),
        )
      } catch {
        return null
      }
    })

    // 3. Append a timeline Interaction on the resolved Family. Idempotent
    //    by checking for an existing interaction tagged with this eventId.
    await step.run('interaction', async () => {
      const familyId = await resolveFamilyByStripeCustomer(db, persisted.stripeCustomerId)
      if (!familyId) return

      const existing = await db.interaction.findFirst({
        where: {
          familyId,
          type: 'payment',
          payload: { path: ['stripeEventId'], equals: eventId },
        },
        select: { id: true },
      })
      if (existing) return

      const classification =
        'classification' in persisted ? persisted.classification : null

      // Deterministic rules win; the advisory AI suggestion only fills in when
      // the rules matched nothing.
      const deterministicHandles = classification?.productHandles ?? []
      const productHandles =
        deterministicHandles.length > 0
          ? deterministicHandles
          : aiProduct
            ? [aiProduct.handle]
            : []
      const productSource: 'rules' | 'ai' | 'none' =
        deterministicHandles.length > 0 ? 'rules' : aiProduct ? 'ai' : 'none'

      let summary: string
      switch (persisted.kind) {
        case 'subscription':
          summary = `Stripe subscription updated (${type})`
          break
        case 'payment':
          summary = productHandles.length
            ? `Stripe payment received — ${productHandles.join(', ')}${productSource === 'ai' ? ' (AI)' : ''}`
            : 'Stripe payment received'
          break
        case 'payment_refund':
          summary = 'Stripe payment refunded'
          break
        default:
          summary = `Stripe invoice payment failed`
      }

      await db.interaction.create({
        data: {
          id: createId(),
          type: 'payment',
          familyId,
          occurredAt: new Date(),
          summary,
          payload: {
            stripeEventId: eventId,
            stripeEventType: type,
            stripeObjectId: persisted.stripeId,
            kind: persisted.kind,
            ...(classification
              ? {
                  productHandles,
                  productCategories: classification.categories,
                  productUnmatched: classification.unmatched,
                  productSource,
                  ...(aiProduct
                    ? {
                        aiProductHandle: aiProduct.handle,
                        aiProductConfidence: aiProduct.confidence,
                        aiProductReason: aiProduct.reason,
                      }
                    : {}),
                }
              : {}),
          },
        },
      })
    })

    // 4. Audit. Idempotent via the requestId == eventId trick.
    await step.run('audit', async () => {
      await writeAuditLogEntry(db, {
        actorId: null,
        action: `stripe.${type}`,
        target: { type: 'Family', id: persisted.familyId ?? 'unknown' },
        requestId: eventId,
        after: {
          stripeEventId: eventId,
          stripeObjectId: persisted.stripeId,
          kind: persisted.kind,
        },
      })
    })

    // 5. Recompute at-risk derivation for this Family. CLAUDE.md §6.4.
    if (persisted.familyId) {
      await step.run('recompute-at-risk', async () => {
        await recomputeAtRiskForFamily(db, persisted.familyId!, {
          requestId: `stripe:${eventId}:at-risk`,
        })
      })
    }

    // 6. Summer Camp / Work Experience purchase → hand off to the summer-camp
    //    pipeline, which records a CampStripePurchase and auto-creates the
    //    camp booking through the CRM (idempotent on the charge id there).
    if (
      persisted.kind === 'payment' &&
      'campPurchase' in persisted &&
      persisted.campPurchase?.matched &&
      persisted.campPurchase.keyword
    ) {
      await step.sendEvent('camp-purchase-detected', {
        name: 'summer-camp/purchase.detected',
        data: {
          stripeChargeId: persisted.stripeId,
          stripePaymentIntentId: persisted.stripePaymentIntentId ?? null,
          amountMinor: persisted.amountMinor,
          currency: persisted.currency,
          customerName: persisted.customerName ?? null,
          customerEmail: persisted.customerEmail ?? null,
          productText: persisted.productText ?? null,
          matchedKeyword: persisted.campPurchase.keyword,
          occurredAt: persisted.receivedAt,
        },
      })
    }

    // 7. Mark the ProviderEvent row processed.
    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: data.providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    return { ok: true, kind: persisted.kind }
  },
)

/**
 * Historic scan: walk recent Stripe charges (default 365 days) and emit a
 * `summer-camp/purchase.detected` event for every succeeded, unrefunded charge
 * whose product text matches "summer camp" / "work experience". Idempotent
 * downstream (the purchase row is keyed on the charge id), so re-running is
 * safe. Admin-triggered from the CRM's Stripe purchases tray.
 */
export const stripeScanCampPurchases = inngest.createFunction(
  {
    id: 'stripe/scan-camp-purchases',
    name: 'Scan Stripe charges for Summer Camp / Work Experience purchases',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { event: 'summer-camp/scan-purchases.requested' },
  async ({ event, step, logger }) => {
    const days = typeof event.data?.['days'] === 'number' ? Math.min(Math.max(event.data['days'], 1), 730) : 365
    const since = Math.floor(Date.now() / 1000) - days * 86_400

    const matches = await step.run('scan', async () => {
      const stripe = createClient()
      const found: Array<{
        stripeChargeId: string
        stripePaymentIntentId: string | null
        amountMinor: number
        currency: string
        customerName: string | null
        customerEmail: string | null
        productText: string | null
        matchedKeyword: string
        occurredAt: string
      }> = []
      let scanned = 0
      for await (const charge of stripe.charges.list({ limit: 100, created: { gte: since } })) {
        scanned += 1
        if (!charge.paid || charge.refunded) continue
        const text = chargeProductText(charge)
        const detection = detectCampPurchase(text)
        if (!detection.matched || !detection.keyword) continue
        found.push({
          stripeChargeId: charge.id,
          stripePaymentIntentId:
            typeof charge.payment_intent === 'string'
              ? charge.payment_intent
              : (charge.payment_intent?.id ?? null),
          amountMinor: charge.amount,
          currency: charge.currency.toUpperCase(),
          customerName: charge.billing_details?.name ?? null,
          customerEmail: charge.billing_details?.email ?? null,
          productText: text || null,
          matchedKeyword: detection.keyword,
          occurredAt: new Date(charge.created * 1000).toISOString(),
        })
      }
      logger.info({ scanned, matched: found.length, days }, 'stripe.camp_purchase_scan')
      return found
    })

    if (matches.length > 0) {
      await step.sendEvent(
        'emit-detections',
        matches.map((m) => ({ name: 'summer-camp/purchase.detected' as const, data: m })),
      )
    }
    return { matched: matches.length, days }
  },
)

export const FUNCTIONS = [stripeEventReceived, stripeScanCampPurchases] as const
