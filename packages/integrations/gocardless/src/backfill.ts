// GoCardless historic import (ADR 0038). Walks the provider's full history —
// customers → mandates → subscriptions → payments — and mirrors everything
// into the CRM, including past (finished / cancelled) subscriptions.
//
// Self-rescheduling: each invocation imports one page (keyset cursor) and
// re-fires the event with the next cursor, so a large account never hits the
// Inngest step ceiling. Idempotent: every upsert is keyed on the GoCardless
// object id, so a re-run converges to the same state.
//
// Contact linking: customers auto-link only on a single unambiguous email
// match (CLAUDE.md §3, §41.1 — never auto-merge). Everything else surfaces in
// the Direct Debit workspace for a human to link.
//
// Auditing: one summary row at completion via markBackfillCompleted — never
// per imported object (CLAUDE.md §17).

import {
  incrementBackfillProgress,
  markBackfillCompleted,
  markBackfillFailed,
  markBackfillRunning,
} from '@studymind/core/backfill'
import {
  syncGcPayment,
  upsertGcCustomerMirror,
  upsertGcMandateMirror,
  upsertGcPaymentMirror,
  upsertGcPayoutMirror,
  upsertGcSubscriptionMirror,
} from '@studymind/core/finance'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient } from './client'
import {
  customerMirrorInput,
  mandateMirrorInput,
  paymentMirrorInput,
  payoutMirrorInput,
  subscriptionMirrorInput,
} from './mirror-map'
import { mapPaymentStatus } from './types'

const PAGE_LIMIT = 200

const PHASES = ['customers', 'mandates', 'subscriptions', 'payouts', 'payments'] as const
type Phase = (typeof PHASES)[number]

interface BackfillEventData {
  jobId?: string
  phase?: Phase
  after?: string | null
  totals?: { processed: number; matched: number; skipped: number }
}

function nextPhase(phase: Phase): Phase | null {
  const idx = PHASES.indexOf(phase)
  return PHASES[idx + 1] ?? null
}

export const gocardlessBackfill = inngest.createFunction(
  {
    id: 'gocardless/backfill',
    name: 'GoCardless: import full Direct Debit history',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { event: 'backfill/gocardless.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as BackfillEventData
    const jobId = data.jobId
    const phase: Phase = data.phase ?? 'customers'
    const after = data.after ?? undefined
    const totals = data.totals ?? { processed: 0, matched: 0, skipped: 0 }

    if (!process.env['GOCARDLESS_ACCESS_TOKEN']) {
      await step.run('fail-unconfigured', async () => {
        await markBackfillFailed(
          db,
          jobId,
          'GOCARDLESS_ACCESS_TOKEN is not set — connect GoCardless first (Settings → Integrations).',
          `gc-backfill:${jobId ?? 'unknown'}`,
        )
      })
      return { skipped: true, reason: 'not_configured' }
    }

    if (!data.phase) {
      await step.run('mark-running', async () => {
        await markBackfillRunning(db, jobId)
      })
    }

    const page = await step.run(`import-${phase}-${after ?? 'start'}`, async () => {
      const client = createClient()
      let processed = 0
      let matched = 0
      let skipped = 0
      let nextAfter: string | null = null

      if (phase === 'customers') {
        const res = await client.listCustomers({ after, limit: PAGE_LIMIT })
        for (const customer of res.items) {
          const result = await upsertGcCustomerMirror(
            db,
            customerMirrorInput(customer, { autoMatch: true }),
          )
          processed += 1
          if (result.contactId) matched += 1
          else skipped += 1
        }
        nextAfter = res.after
      } else if (phase === 'mandates') {
        const res = await client.listMandates({ after, limit: PAGE_LIMIT })
        for (const mandate of res.items) {
          // A mandate inherits its Family link through its customer when the
          // customer is already linked; otherwise it stays unlinked but
          // mirrored.
          const customer = mandate.links.customer
            ? await db.gcCustomer.findUnique({
                where: { gcCustomerId: mandate.links.customer },
                select: { familyId: true },
              })
            : null
          const result = await upsertGcMandateMirror(
            db,
            mandateMirrorInput(mandate, { familyId: customer?.familyId ?? null }),
          )
          processed += 1
          if (result.familyId) matched += 1
          else skipped += 1
        }
        nextAfter = res.after
      } else if (phase === 'payouts') {
        const res = await client.listPayouts({ after, limit: PAGE_LIMIT })
        for (const payout of res.items) {
          await upsertGcPayoutMirror(db, payoutMirrorInput(payout))
          processed += 1
          matched += 1
        }
        nextAfter = res.after
      } else if (phase === 'subscriptions') {
        const res = await client.listSubscriptions({ after, limit: PAGE_LIMIT })
        for (const subscription of res.items) {
          const mandateRow = subscription.links.mandate
            ? await db.gcMandate.findUnique({
                where: { gcMandateId: subscription.links.mandate },
                select: { gcCustomerId: true },
              })
            : null
          await upsertGcSubscriptionMirror(
            db,
            subscriptionMirrorInput(subscription, {
              gcCustomerId: mandateRow?.gcCustomerId ?? null,
            }),
          )
          processed += 1
          matched += 1
        }
        nextAfter = res.after
      } else {
        const res = await client.listPayments({ after, limit: PAGE_LIMIT })
        for (const payment of res.items) {
          const mandateId = payment.links.mandate ?? null
          const mandateRow = mandateId
            ? await db.gcMandate.findUnique({
                where: { gcMandateId: mandateId },
                select: { gcCustomerId: true, familyId: true },
              })
            : null
          await upsertGcPaymentMirror(
            db,
            paymentMirrorInput(payment, { gcCustomerId: mandateRow?.gcCustomerId ?? null }),
          )

          // Family-linked payments also land in the reconciliation-facing
          // Payment table (same shape the live webhook writes).
          if (mandateId && mandateRow?.familyId) {
            const status = mapPaymentStatus(payment.status)
            const isConfirmed = status === 'confirmed' || status === 'paid_out'
            await syncGcPayment(db, {
              gcPaymentId: payment.id,
              gcMandateId: mandateId,
              amountMinor: payment.amount,
              currency: payment.currency.toUpperCase(),
              receivedAt: new Date(payment.created_at),
              confirmedAt:
                isConfirmed && payment.charge_date ? new Date(payment.charge_date) : undefined,
            })
            matched += 1
          } else {
            skipped += 1
          }
          processed += 1
        }
        nextAfter = res.after
      }

      await incrementBackfillProgress(db, jobId, {
        processed,
        matched,
        skipped,
        lastEventId: `${phase}:${nextAfter ?? 'done'}`,
      })

      return { processed, matched, skipped, nextAfter }
    })

    const newTotals = {
      processed: totals.processed + page.processed,
      matched: totals.matched + page.matched,
      skipped: totals.skipped + page.skipped,
    }

    const next: { phase: Phase; after: string | null } | null = page.nextAfter
      ? { phase, after: page.nextAfter }
      : nextPhase(phase)
        ? { phase: nextPhase(phase) as Phase, after: null }
        : null

    if (next) {
      await step.sendEvent('next-page', {
        name: 'backfill/gocardless.requested',
        data: {
          jobId,
          phase: next.phase,
          after: next.after,
          totals: newTotals,
        } satisfies BackfillEventData,
      })
      return { ok: true, phase, continued: true }
    }

    await step.run('complete', async () => {
      await markBackfillCompleted(db, jobId, {
        processed: newTotals.processed,
        matched: newTotals.matched,
        skipped: newTotals.skipped,
        requestId: `gc-backfill:${jobId ?? 'unknown'}`,
      })
    })

    logger.info({ jobId, ...newTotals }, 'gocardless backfill complete')
    return { ok: true, ...newTotals }
  },
)
