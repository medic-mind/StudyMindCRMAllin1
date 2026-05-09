// Tender draft signoff. CLAUDE.md §43.1, §42.
//
// SEMH or EHCP-heavy tenders require BOTH the account lead AND a DSL signoff
// before the draft state advances to `approved` (which is the gate for moving
// the parent tender to `submitted`). Non-SEMH tenders only need the account
// lead.
//
// Decisions:
//   approve            — stamps the role's signoff. Becomes `approved` when
//                        all required signoffs are in.
//   request_changes    — leaves signoffState as `pending`; writes Interaction
//                        and audit so the requester is notified.
//   reject             — terminal state `rejected`. Draft locked.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

type DbWriter = PrismaClient | Prisma.TransactionClient

export type SignoffRole = 'account_lead' | 'dsl'
export type SignoffDecision = 'approve' | 'request_changes' | 'reject'

export interface SignoffTenderDraftInput {
  draftId: string
  signerId: string
  role: SignoffRole
  decision: SignoffDecision
  rationale?: string
}

export interface ActorCtx {
  actorId: string
  requestId: string
}

export interface SignoffTenderDraftResult {
  signoffState: string
  isApproved: boolean
}

const STATE_AFTER_ACCOUNT_LEAD_APPROVE = 'account_lead_approved'
const STATE_AFTER_DSL_APPROVE = 'dsl_approved'
const STATE_APPROVED = 'approved'
const STATE_REJECTED = 'rejected'

/**
 * Apply a signoff decision to a TenderDraftRequest.
 *
 * Required-signoff set:
 *   - SEMH/EHCP-heavy → { account_lead, dsl }
 *   - other            → { account_lead }
 *
 * Approval is order-independent: account lead can approve before DSL, or
 * DSL can approve first; either way we land at `approved` once the set is
 * complete.
 */
export async function signoffTenderDraft(
  db: DbWriter,
  input: SignoffTenderDraftInput,
  ctx: ActorCtx,
): Promise<SignoffTenderDraftResult> {
  const draft = await db.tenderDraftRequest.findUniqueOrThrow({
    where: { id: input.draftId },
    select: {
      id: true,
      tenderId: true,
      signoffState: true,
      tender: {
        select: { id: true, isSemhOrEhcpHeavy: true, state: true },
      },
    },
  })

  if (draft.signoffState === STATE_APPROVED || draft.signoffState === STATE_REJECTED) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Draft is already ${draft.signoffState} and cannot accept further signoffs`,
    )
  }

  const requiresDsl = draft.tender.isSemhOrEhcpHeavy

  let nextState: string
  let isApproved = false

  if (input.decision === 'reject') {
    nextState = STATE_REJECTED
  } else if (input.decision === 'request_changes') {
    // Stay in current state but the timeline + audit record the request.
    nextState = draft.signoffState
  } else {
    // approve — combine prior state with this role's approval.
    if (input.role === 'account_lead') {
      if (draft.signoffState === STATE_AFTER_DSL_APPROVE) {
        nextState = STATE_APPROVED
        isApproved = true
      } else if (!requiresDsl) {
        nextState = STATE_APPROVED
        isApproved = true
      } else {
        nextState = STATE_AFTER_ACCOUNT_LEAD_APPROVE
      }
    } else {
      // role === 'dsl'
      if (!requiresDsl) {
        throw new BusinessError(
          'INVALID_STATE_TRANSITION',
          'DSL signoff is not required for this draft',
        )
      }
      if (draft.signoffState === STATE_AFTER_ACCOUNT_LEAD_APPROVE) {
        nextState = STATE_APPROVED
        isApproved = true
      } else {
        nextState = STATE_AFTER_DSL_APPROVE
      }
    }
  }

  await db.tenderDraftRequest.update({
    where: { id: input.draftId },
    data: { signoffState: nextState, updatedById: ctx.actorId },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'tender_draft_signed_off',
      tenderId: draft.tenderId,
      occurredAt: new Date(),
      summary: `Tender draft ${input.decision} by ${input.role}`,
      payload: {
        event: 'tender.draft_signed_off',
        draftId: draft.id,
        signerId: input.signerId,
        role: input.role,
        decision: input.decision,
        rationale: input.rationale ?? null,
        prevState: draft.signoffState,
        nextState,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'tender.draft_signed_off',
    target: { type: 'TenderDraftRequest', id: draft.id },
    requestId: ctx.requestId,
    purpose: input.rationale,
    before: { signoffState: draft.signoffState },
    after: {
      signoffState: nextState,
      role: input.role,
      decision: input.decision,
    },
  })

  return { signoffState: nextState, isApproved }
}
