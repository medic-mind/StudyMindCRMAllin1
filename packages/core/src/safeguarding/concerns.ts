// Safeguarding concern workflow. CLAUDE.md §42.
//
// raiseConcern, triageAction, recordLaReferral are the only ways to mutate
// safeguarding state. Every step writes an audit row. The encrypted body
// goes through encryptField; only a redacted summary lands on the timeline.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import { encryptField } from './encrypt'

type DbWriter = PrismaClient

export type SourceType = 'call' | 'message' | 'email' | 'third_party' | 'note'
export type Urgency = 'routine' | 'urgent' | 'immediate'

export interface RaiseConcernCtx {
  actorId: string
  requestId: string
  /** Slack notifier — defaults to a no-op stub if Slack is not wired. */
  notifyDsl?: (input: NotifyDslInput) => Promise<void>
  /** Inngest sender — defaults to a no-op stub. Used to fire dsl/page. */
  sendEvent?: (input: { name: string; data: Record<string, unknown> }) => Promise<void>
  /**
   * Page on-call (PagerDuty) for `immediate` urgency. CLAUDE.md §42.1.
   * Boundary-injected so packages/core stays free of integration deps.
   */
  pageOnCall?: (input: PageOnCallInput) => Promise<void>
  /**
   * Email the DPO with a redacted alert for `immediate` urgency. CLAUDE.md
   * §42.1. Body must contain no plaintext from the concern.
   */
  emailDpo?: (input: EmailDpoInput) => Promise<void>
  /** Slack `#crm-safeguarding-alerts` post. Boundary-injected. */
  postSafeguardingAlert?: (input: SafeguardingAlertInput) => Promise<void>
}

export interface PageOnCallInput {
  flagId: string
  contactId: string
  urgency: Urgency
  /** Stable PagerDuty dedup key; same flagId collapses re-pages. */
  dedupKey: string
}

export interface EmailDpoInput {
  flagId: string
  contactId: string
  urgency: Urgency
  /** Already redacted — no plaintext concern body. */
  redactedSummary: string
}

export interface SafeguardingAlertInput {
  flagId: string
  contactId: string
  urgency: Urgency
  redactedSummary: string
}

export interface RaiseConcernInput {
  contactId: string
  raisedBy: string
  sourceType: SourceType
  sourceId: string | null
  urgency: Urgency
  body: string
  isInPlacement: boolean
}

export interface RaiseConcernResult {
  flagId: string
}

export interface NotifyDslInput {
  dslUserId: string
  contactId: string
  flagId: string
  urgency: Urgency
  redactedSummary: string
}

const DEFAULT_NOTIFIER = async (_input: NotifyDslInput): Promise<void> => {
  // Stub: real implementation lives in @studymind/integration-slack once
  // outbound DM is built. CLAUDE.md §12 (single bot, no DMs today) — until
  // that ADR is updated, this is a no-op.
}

const DEFAULT_SENDER = async (_input: { name: string; data: Record<string, unknown> }) => {
  /* no-op default; tests inject a spy */
}

async function pickOnDutyDsl(db: DbWriter): Promise<string> {
  const now = new Date()
  // dsl_rota lands in the slice-6 migration; defensive lookup so this works
  // before the migration runs in dev.
  const rotaModel = (db as unknown as Record<string, unknown>)['dslRota']
  if (rotaModel && typeof rotaModel === 'object') {
    try {
      const row = await (
        db as unknown as {
          dslRota: {
            findFirst: (args: unknown) => Promise<{ userId: string } | null>
          }
        }
      ).dslRota.findFirst({
        where: {
          weekStart: { lte: now },
          weekEnd: { gte: now },
          role: 'primary',
        },
        select: { userId: true },
      })
      if (row) return row.userId
    } catch {
      // table not yet migrated — fall through to env.
    }
  }
  const fallback = process.env['DEFAULT_DSL_USER_ID']
  if (!fallback) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      'No on-duty DSL configured (dsl_rota empty and DEFAULT_DSL_USER_ID unset).',
    )
  }
  return fallback
}

function redactSummary(body: string, urgency: Urgency, sourceType: SourceType): string {
  // Don't put the body itself in payload — only a length-and-source descriptor.
  return `Safeguarding concern (${urgency}) raised from ${sourceType}; ${body.length} chars in encrypted body.`
}

/**
 * Raise a safeguarding concern. Encrypts the body, creates the flag,
 * appends a redacted timeline Interaction, notifies the on-duty DSL, and
 * writes the audit row.
 */
export async function raiseConcern(
  db: DbWriter,
  input: RaiseConcernInput,
  ctx: RaiseConcernCtx,
): Promise<RaiseConcernResult> {
  const dslUserId = await pickOnDutyDsl(db)
  const flagId = createId()

  // Persist the flag first so encryptField has an owner id we can bind to AAD.
  await db.safeguardingFlag.create({
    data: {
      id: flagId,
      contactId: input.contactId,
      state: 'concern_logged',
      urgency: input.urgency,
      dslUserId,
      raisedById: input.raisedBy,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await encryptField(db, {
    ownerType: 'Contact',
    ownerId: input.contactId,
    fieldName: `safeguarding_body:${flagId}`,
    plaintext: input.body,
    ctx: {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      purpose: 'safeguarding.concern_raised',
    },
  })

  const redactedSummary = redactSummary(input.body, input.urgency, input.sourceType)

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'safeguarding_concern_raised',
      contactId: input.contactId,
      occurredAt: new Date(),
      summary: 'Safeguarding concern raised',
      payload: {
        flagId,
        urgency: input.urgency,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        isInPlacement: input.isInPlacement,
        redactedSummary,
        encryptedFieldKey: `safeguarding_body:${flagId}`,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'safeguarding.concern_raised',
    target: { type: 'SafeguardingFlag', id: flagId },
    requestId: ctx.requestId,
    purpose: 'safeguarding.concern_raised',
    after: { contactId: input.contactId, urgency: input.urgency, dslUserId },
  })

  const notifier = ctx.notifyDsl ?? DEFAULT_NOTIFIER
  await notifier({
    dslUserId,
    contactId: input.contactId,
    flagId,
    urgency: input.urgency,
    redactedSummary,
  })

  if (input.urgency === 'immediate') {
    const send = ctx.sendEvent ?? DEFAULT_SENDER
    await send({
      name: 'dsl/page',
      data: { dslUserId, flagId, contactId: input.contactId },
    })

    // Three-way fan-out for immediate concerns. CLAUDE.md §42.1.
    // We do NOT include any plaintext from `input.body` in any of these —
    // body lives encrypted in EncryptedField.
    if (ctx.pageOnCall) {
      await ctx.pageOnCall({
        flagId,
        contactId: input.contactId,
        urgency: input.urgency,
        dedupKey: `sg-imm:${flagId}`,
      })
    }
    if (ctx.postSafeguardingAlert) {
      await ctx.postSafeguardingAlert({
        flagId,
        contactId: input.contactId,
        urgency: input.urgency,
        redactedSummary,
      })
    }
    if (ctx.emailDpo) {
      await ctx.emailDpo({
        flagId,
        contactId: input.contactId,
        urgency: input.urgency,
        redactedSummary,
      })
    }
  }

  return { flagId }
}

// -----------------------------------------------------------------------------
// Triage
// -----------------------------------------------------------------------------

export type TriageAction =
  | 'acknowledge'
  | 'request_info'
  | 'escalate_restricted'
  | 'refer_la'
  | 'refer_mash'
  | 'close_resolved'

export interface TriageActionInput {
  flagId: string
  action: TriageAction
  rationale: string
}

export interface TriageActionCtx {
  actorId: string
  requestId: string
  /** Caller's role; primary or deputy DSL only. */
  role: 'admin' | 'dsl'
}

/**
 * Apply a DSL triage action to a SafeguardingFlag. Asserts the actor is the
 * assigned DSL (or admin), updates the flag state, appends a timeline
 * Interaction, and audits the action.
 */
export async function triageAction(
  db: DbWriter,
  input: TriageActionInput,
  ctx: TriageActionCtx,
): Promise<void> {
  const flag = await db.safeguardingFlag.findUniqueOrThrow({
    where: { id: input.flagId },
    select: { id: true, state: true, contactId: true, dslUserId: true },
  })

  if (ctx.role !== 'admin' && flag.dslUserId !== ctx.actorId) {
    throw new BusinessError(
      'CONTACT_RESTRICTED',
      'Only the assigned DSL (or admin) may triage this flag.',
    )
  }

  const newState =
    input.action === 'escalate_restricted'
      ? 'restricted_access'
      : input.action === 'close_resolved'
        ? 'none'
        : flag.state

  await db.safeguardingFlag.update({
    where: { id: input.flagId },
    data: {
      state: newState,
      closedAt: input.action === 'close_resolved' ? new Date() : null,
      updatedById: ctx.actorId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'safeguarding_concern_raised', // Reuse this enum value; subtype in payload.
      contactId: flag.contactId,
      occurredAt: new Date(),
      summary: `Safeguarding ${input.action}`,
      payload: {
        flagId: flag.id,
        triageAction: input.action,
        rationale: input.rationale,
        prevState: flag.state,
        newState,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: `safeguarding.${input.action}`,
    target: { type: 'SafeguardingFlag', id: flag.id },
    requestId: ctx.requestId,
    purpose: input.rationale,
    before: { state: flag.state },
    after: { state: newState },
  })
}

// -----------------------------------------------------------------------------
// LA referral
// -----------------------------------------------------------------------------

export interface RecordLaReferralInput {
  flagId: string
  la: string
  caseworker: string
  referenceNumber: string
  channel: 'email' | 'phone' | 'portal' | 'post'
}

export interface RecordLaReferralCtx {
  actorId: string
  requestId: string
}

/**
 * Record an LA referral against a flag. The body of the referral is the
 * concatenation of the input fields and is encrypted; the timeline shows
 * the LA name and reference number only.
 */
export async function recordLaReferral(
  db: DbWriter,
  input: RecordLaReferralInput,
  ctx: RecordLaReferralCtx,
): Promise<void> {
  const flag = await db.safeguardingFlag.findUniqueOrThrow({
    where: { id: input.flagId },
    select: { id: true, contactId: true },
  })

  const body = JSON.stringify({
    la: input.la,
    caseworker: input.caseworker,
    referenceNumber: input.referenceNumber,
    channel: input.channel,
  })

  await encryptField(db, {
    ownerType: 'Contact',
    ownerId: flag.contactId,
    fieldName: `la_referral:${flag.id}:${input.referenceNumber}`,
    plaintext: body,
    ctx: {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      purpose: 'safeguarding.la_referral',
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'safeguarding_la_referral',
      contactId: flag.contactId,
      occurredAt: new Date(),
      summary: `LA referral: ${input.la}`,
      payload: {
        flagId: flag.id,
        la: input.la,
        referenceNumber: input.referenceNumber,
        channel: input.channel,
        // caseworker name redacted from timeline; encrypted body has it.
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'safeguarding.la_referral',
    target: { type: 'SafeguardingFlag', id: flag.id },
    requestId: ctx.requestId,
    purpose: 'safeguarding.la_referral',
    after: {
      la: input.la,
      referenceNumber: input.referenceNumber,
      channel: input.channel,
    },
  })
}
