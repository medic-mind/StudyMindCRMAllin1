// Worker boundary: pick a purchase up from a payment-alert email and enrol the
// buyer into their weekly class (ADR 0048). Fired by the Gmail sync
// (`processMessage`) when a message from a configured alert sender arrives and
// the `stripe.purchase_email_ingest_enabled` flag is on — so the AI extraction
// + enrolment (which reach the enrolment engine in apps/web) run here, not in
// the integration.
//
// Record-keeping + service provision ONLY: we log the purchase on the buyer's
// contact and enrol confident weekly-class matches. Nothing here charges,
// refunds, or invoices, and there is no Stripe API call.

import { createId } from '@paralleldrive/cuid2'

import {
  buildPurchaseEmailPrompt,
  purchaseEmailSchema,
  PURCHASE_EMAIL_PROMPT_VERSION,
  runStructured,
} from '@studymind/ai'
import { writeAuditLogEntry } from '@studymind/audit'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'
import { enrollFromPurchase } from '@/lib/webinar/enrollment-service'

const SYSTEM_ACTOR = 'system:webinar/purchase-email'

export const purchaseEmailReceived = inngest.createFunction(
  {
    id: 'webinar/purchase-email',
    name: 'Webinar: record + enrol from a payment-alert email',
    // AI-touching → keep concurrency low (CLAUDE.md §17).
    concurrency: { limit: 3 },
    retries: 3,
  },
  { event: 'webinar/purchase-email.received' },
  async ({ event, step, logger }) => {
    const { gmailMessageId, requestId, subject, body, fromEmail } = event.data as {
      gmailMessageId: string
      agentId?: string | null
      requestId: string
      fromEmail: string | null
      subject: string
      body: string
    }

    // Idempotent on the source email: a re-sync of the same alert must not
    // re-run the AI or double-record. The recorded purchase Interaction is the
    // marker.
    const already = await step.run('dedupe', () =>
      db.interaction.findFirst({
        where: {
          type: 'payment',
          payload: { path: ['gmailMessageId'], equals: gmailMessageId },
        },
        select: { id: true },
      }),
    )
    if (already) return { skipped: 'already_recorded' }

    const extracted = await step.run('extract', () => {
      const prompt = buildPurchaseEmailPrompt({ subject, body })
      return runStructured({
        task: 'purchase_email',
        promptVersion: PURCHASE_EMAIL_PROMPT_VERSION,
        schema: purchaseEmailSchema,
        system: prompt.system,
        user: prompt.user,
        model: 'gpt-4o-mini',
        ctx: { requestId, source: 'webinar.purchase_email' },
      })
    })

    if (!extracted.isPurchase) {
      logger.info({ gmailMessageId }, 'purchase-email: not a completed purchase — skipping')
      return { skipped: 'not_a_purchase' }
    }

    const email = extracted.buyerEmail?.trim().toLowerCase() || null
    const name = extracted.buyerName?.trim() || null
    if (!email && !name) {
      logger.warn({ gmailMessageId }, 'purchase-email: no buyer identity — cannot attribute')
      return { skipped: 'no_buyer_identity' }
    }

    // Match the buyer by email (the strong signal on a receipt); else create a
    // lightweight contact so the purchase has a home (§14 — email never
    // silent-creates a contact, but a confirmed purchase is a real customer,
    // the deliberate ingestion exception like the call/lead resolvers).
    const contactId = await step.run('resolve-contact', async () => {
      if (email) {
        const existing = await db.contact.findFirst({
          where: { email, deletedAt: null },
          select: { id: true },
        })
        if (existing) return existing.id
      }
      const [firstName, ...rest] = (name ?? '').split(/\s+/)
      const id = createId()
      await db.contact.create({
        data: {
          id,
          kind: 'unclassified',
          firstName: firstName || null,
          lastName: rest.length > 0 ? rest.join(' ') : null,
          email,
          referralSource: 'Stripe purchase (email)',
          createdById: null,
          updatedById: null,
        },
      })
      return id
    })

    await step.run('record-purchase', () =>
      db.interaction.create({
        data: {
          id: createId(),
          type: 'payment',
          contactId,
          occurredAt: new Date(),
          summary: extracted.productDescription
            ? `Purchase — ${extracted.productDescription}`
            : 'Purchase received',
          payload: {
            event: 'payment.created',
            source: 'stripe_email',
            gmailMessageId,
            fromEmail,
            product: extracted.productDescription,
            amountMinor: extracted.amountMinor,
            currency: extracted.currency,
            billingInterval: extracted.billingInterval,
            externalRef: extracted.externalRef,
          },
        },
      }),
    )

    const enrol = extracted.productDescription
      ? await step.run('enrol', () =>
          enrollFromPurchase(db, {
            contactId,
            productText: extracted.productDescription as string,
            billingInterval: extracted.billingInterval,
            actorId: null,
            requestId,
            useAi: true,
          }),
        )
      : { matched: 0, autoEnrolled: 0, pendingReview: 0, cohort: null, reason: 'no_class_match' as const }

    await step.run('audit', () =>
      writeAuditLogEntry(db, {
        actorId: SYSTEM_ACTOR,
        action: 'payment.created',
        target: { type: 'Contact', id: contactId },
        requestId: `purchase-email:${gmailMessageId}`,
        after: {
          source: 'stripe_email',
          product: extracted.productDescription,
          amountMinor: extracted.amountMinor,
          currency: extracted.currency,
          ...enrol,
        },
      }),
    )

    logger.info({ gmailMessageId, contactId, ...enrol }, 'purchase-email processed')
    return { contactId, ...enrol }
  },
)
