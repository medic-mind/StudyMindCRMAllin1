// Outbound calls TO GoCardless.
// Idempotency keys per CLAUDE.md §9 + §17. Audit on every Family / Financial
// write per §20.
//
// The pattern for redirect-flow creation (the hosted page where a parent
// confirms bank details):
//   1. Build a deterministic idempotency key per (family, billingContact).
//   2. Persist a MandateIntent in `pending` BEFORE calling GoCardless. If a
//      previous successful run already created a redirect_flow, return that
//      row — do not create a second redirect flow.
//   3. Call GoCardless with the same key as the `session_token`.
//   4. On success: mark intent `succeeded`, store flow id + url, audit.
//   5. On failure: leave intent in `pending_review` and rethrow.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { createClient } from './client'

export type DbClient = PrismaClient | Prisma.TransactionClient

export interface CreateHostedRedirectFlowInput {
  familyId: string
  billingContactId: string
  /** Where GoCardless returns the customer after they finish the hosted flow. */
  redirectUrl: string
  /** Optional human-friendly label shown by GoCardless. */
  description?: string
  actorId: string
  requestId: string
}

export type RedirectFlowStatus = 'succeeded' | 'pending_review'

export interface CreateHostedRedirectFlowResult {
  mandateIntentId: string
  status: RedirectFlowStatus
  redirectFlowId?: string
  redirectUrl?: string
}

export function buildMandateIntentIdempotencyKey(
  familyId: string,
  billingContactId: string,
): string {
  return `mandate_intent:${familyId}:${billingContactId}`
}

/**
 * Create a GoCardless redirect flow that the family completes to authorise a
 * Direct Debit mandate. The MandateIntent row is the durable record of the
 * intent; the redirect flow id and URL are filled in once GoCardless responds.
 */
export async function createHostedRedirectFlow(
  db: DbClient,
  input: CreateHostedRedirectFlowInput,
): Promise<CreateHostedRedirectFlowResult> {
  const { familyId, billingContactId, redirectUrl, description, actorId, requestId } = input

  const idempotencyKey = buildMandateIntentIdempotencyKey(familyId, billingContactId)

  // 1. Upsert MandateIntent in `pending`. The unique key ensures a retried
  //    call returns the same row.
  const intent = await db.mandateIntent.upsert({
    where: { idempotencyKey },
    create: {
      id: createId(),
      familyId,
      billingContactId,
      idempotencyKey,
      status: 'pending',
      createdById: actorId,
      updatedById: actorId,
    },
    update: {
      // Keep existing status — replays must not regress a succeeded intent.
    },
    select: {
      id: true,
      status: true,
      redirectFlowId: true,
      redirectUrl: true,
    },
  })

  if (intent.status === 'succeeded' && intent.redirectFlowId && intent.redirectUrl) {
    return {
      mandateIntentId: intent.id,
      status: 'succeeded',
      redirectFlowId: intent.redirectFlowId,
      redirectUrl: intent.redirectUrl,
    }
  }

  // 2. Call GoCardless. The session_token doubles as our Idempotency-Key
  //    inside the HTTP client.
  const client = createClient()
  try {
    const flow = await client.createRedirectFlow({
      description: description ?? 'StudyMind Direct Debit',
      session_token: idempotencyKey,
      success_redirect_url: redirectUrl,
      metadata: {
        familyId,
        billingContactId,
      },
    })

    await db.mandateIntent.update({
      where: { id: intent.id },
      data: {
        status: 'succeeded',
        redirectFlowId: flow.id,
        redirectUrl: flow.redirect_url,
        updatedById: actorId,
      },
    })

    await writeAuditLogEntry(db, {
      actorId,
      action: 'gocardless.redirect_flow.created',
      target: { type: 'Family', id: familyId },
      requestId,
      after: {
        mandateIntentId: intent.id,
        redirectFlowId: flow.id,
        billingContactId,
      },
    })

    return {
      mandateIntentId: intent.id,
      status: 'succeeded',
      redirectFlowId: flow.id,
      redirectUrl: flow.redirect_url,
    }
  } catch (err) {
    await db.mandateIntent.update({
      where: { id: intent.id },
      data: { status: 'pending_review', updatedById: actorId },
    })
    throw err
  }
}
