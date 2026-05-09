// Tender domain. Persistence + state-machine glue.
// See CLAUDE.md §43.1 and packages/core/src/tender/state.ts.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import {
  isTerminalTenderState,
  transitionTender as transitionTenderPure,
  type TenderState,
} from './state'

type DbWriter = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}

export interface CreateTenderInput {
  name: string
  laName: string
  commissioner?: string | null
  opportunityRef?: string | null
  accountLeadId: string
  dueAt?: Date | null
  contractValueMinor?: number | null
  isSemhOrEhcpHeavy?: boolean
}

export interface CreateTenderResult {
  tenderId: string
}

/**
 * Create a Tender at `identified` state, write the audit row, and append a
 * `tender.state_changed` Interaction (from `null` to `identified`).
 */
export async function createTender(
  db: DbWriter,
  input: CreateTenderInput,
  ctx: ActorCtx,
): Promise<CreateTenderResult> {
  const id = createId()
  await db.tender.create({
    data: {
      id,
      name: input.name,
      laName: input.laName,
      commissioner: input.commissioner ?? null,
      opportunityRef: input.opportunityRef ?? null,
      ownerUserId: input.accountLeadId,
      accountLeadId: input.accountLeadId,
      contractValueMinor: input.contractValueMinor ?? null,
      dueAt: input.dueAt ?? null,
      isSemhOrEhcpHeavy: input.isSemhOrEhcpHeavy ?? false,
      state: 'identified',
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'tender_state_changed',
      tenderId: id,
      occurredAt: new Date(),
      summary: 'Tender identified',
      payload: {
        event: 'tender.state_changed',
        from: null,
        to: 'identified',
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'tender.created',
    target: { type: 'Tender', id },
    requestId: ctx.requestId,
    after: {
      name: input.name,
      laName: input.laName,
      accountLeadId: input.accountLeadId,
      isSemhOrEhcpHeavy: input.isSemhOrEhcpHeavy ?? false,
    },
  })

  return { tenderId: id }
}

export interface TransitionTenderInput {
  tenderId: string
  to: TenderState
  reason?: string
}

/**
 * Persist a state transition. Validates against the pure state machine
 * before any write; throws `BusinessError('INVALID_STATE_TRANSITION')` on
 * an illegal hop. Always writes a `tender.state_changed` Interaction and
 * an audit row.
 */
export async function transitionTender(
  db: DbWriter,
  input: TransitionTenderInput,
  ctx: ActorCtx,
): Promise<{ from: TenderState; to: TenderState }> {
  const tender = await db.tender.findUniqueOrThrow({
    where: { id: input.tenderId },
    select: { id: true, state: true },
  })

  const from = tender.state as TenderState
  const result = transitionTenderPure(from, input.to)
  if (!result.ok) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Tender ${input.tenderId} cannot move from ${from} to ${input.to}`,
      { from, to: input.to, reason: result.reason },
    )
  }

  const outcomePatch =
    input.to === 'awarded' || input.to === 'rejected' || input.to === 'withdrawn'
      ? { outcome: input.to, outcomeReason: input.reason ?? null }
      : {}

  await db.tender.update({
    where: { id: input.tenderId },
    data: {
      state: input.to,
      submittedAt: input.to === 'submitted' ? new Date() : undefined,
      ...outcomePatch,
      updatedById: ctx.actorId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'tender_state_changed',
      tenderId: input.tenderId,
      occurredAt: new Date(),
      summary: `Tender ${from} → ${input.to}`,
      payload: {
        event: 'tender.state_changed',
        from,
        to: input.to,
        reason: input.reason ?? null,
        terminal: isTerminalTenderState(input.to),
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'tender.state_changed',
    target: { type: 'Tender', id: input.tenderId },
    requestId: ctx.requestId,
    purpose: input.reason,
    before: { state: from },
    after: { state: input.to },
  })

  return { from, to: input.to }
}

export interface TenderRecord {
  id: string
  name: string
  laName: string
  commissioner: string | null
  state: TenderState
  accountLeadId: string | null
  contractValueMinor: number | null
  dueAt: Date | null
  isSemhOrEhcpHeavy: boolean
}

export async function getTenderById(
  db: DbWriter,
  tenderId: string,
): Promise<TenderRecord | null> {
  const t = await db.tender.findUnique({
    where: { id: tenderId },
    select: {
      id: true,
      name: true,
      laName: true,
      commissioner: true,
      state: true,
      accountLeadId: true,
      contractValueMinor: true,
      dueAt: true,
      isSemhOrEhcpHeavy: true,
    },
  })
  if (!t) return null
  return {
    id: t.id,
    name: t.name,
    laName: t.laName,
    commissioner: t.commissioner,
    state: t.state as TenderState,
    accountLeadId: t.accountLeadId,
    contractValueMinor: t.contractValueMinor,
    dueAt: t.dueAt,
    isSemhOrEhcpHeavy: t.isSemhOrEhcpHeavy,
  }
}

export {
  TENDER_STATES,
  TENDER_TRANSITIONS,
  isTerminalTenderState,
  type InvalidTransition,
  type TenderState,
  type ValidTransition,
} from './state'
