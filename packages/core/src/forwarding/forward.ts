// Forward a query about a contact to one of the configured rules. The agent
// picks a rule from the contact page, edits the rendered subject/body in a
// modal, and submits. We:
//   1. Look the rule up (must be non-archived).
//   2. Send the email via the injected `sendForwardingEmail` sender — this is
//      Gmail-backed (Google OAuth) in production (apps/web/lib/forwarding/senders.ts).
//      `packages/core` is pure domain and may not import integration clients
//      (CLAUDE.md §5 module boundaries), hence the injection.
//   3. Persist an `email_forwarded` Interaction on the contact carrying the
//      rule key/label, recipients, rendered subject/body, and the sender
//      result.
//   4. Write an audit row (`forwarding.email_sent`).
//
// A failed send is still recorded (status `failed`) so the timeline shows the
// attempt. We never silently drop a forward — every click leaves a trace.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

import { renderTemplate } from './templates'
import type {
  ForwardingSendInput,
  ForwardingSendResult,
  ForwardingTemplateContext,
} from './types'

type Db = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}

/** Provider-agnostic result of attempting to send the forward email. */
export interface ForwardingSenderResult {
  status: 'sent' | 'skipped' | 'failed'
  /** Provider message id on success; null when skipped or unavailable. */
  resendId: string | null
  detail?: string
}

export interface ForwardingSenderArgs {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  /** From-address overrides default; rule-level not used yet. */
  from?: string
}

export type ForwardingSender = (args: ForwardingSenderArgs) => Promise<ForwardingSenderResult>

/**
 * Build the template context an admin can reference in subject/body. Missing
 * values render as empty strings rather than blocking the send. The contact
 * is the canonical anchor; the family is best-effort.
 */
export function buildTemplateContext(input: {
  appUrl: string
  contact: {
    id: string
    firstName: string | null
    lastName: string | null
    email: string | null
    phoneE164: string | null
  }
  family: { name: string | null } | null
  agent: { name: string | null; email: string }
  notes: string
}): ForwardingTemplateContext {
  const fullName = [input.contact.firstName, input.contact.lastName]
    .filter(Boolean)
    .join(' ')
    .trim()
  const contactName = fullName.length > 0 ? fullName : 'this contact'
  const base = input.appUrl.replace(/\/$/, '')
  return {
    contactName,
    contactEmail: input.contact.email ?? '',
    contactPhone: input.contact.phoneE164 ?? '',
    contactId: input.contact.id,
    contactLink: `${base}/contacts/${input.contact.id}`,
    familyName: input.family?.name ?? '',
    agentName: input.agent.name ?? input.agent.email,
    agentEmail: input.agent.email,
    notes: input.notes,
  }
}

/**
 * Render a rule's subject + body against the template context. Pure — no
 * side effects. Used by the preview tRPC procedure so the modal shows the
 * agent what will be sent before they touch it.
 */
export function renderRule(
  rule: { subjectTemplate: string; bodyTemplate: string },
  context: ForwardingTemplateContext,
): { subject: string; body: string } {
  return {
    subject: renderTemplate(rule.subjectTemplate, context),
    body: renderTemplate(rule.bodyTemplate, context),
  }
}

/**
 * Forward a query about a contact via the picked rule. The caller supplies the
 * final subject/body (the agent edited them in the modal), so we send exactly
 * what was approved. Records the send as an `email_forwarded` Interaction on
 * the contact and audits the action. Returns the per-channel result for the
 * UI toast.
 */
export async function forwardEmail(
  db: Db,
  input: ForwardingSendInput & {
    sender: ForwardingSender
  },
  ctx: ActorCtx,
): Promise<ForwardingSendResult> {
  const rule = await db.forwardingRule.findUnique({ where: { id: input.ruleId } })
  if (!rule) {
    throw new BusinessError('FORWARDING_RULE_NOT_FOUND', 'Forwarding rule not found')
  }
  if (rule.archivedAt != null) {
    throw new BusinessError('FORWARDING_RULE_ARCHIVED', 'Forwarding rule is archived')
  }

  const contact = await db.contact.findFirst({
    where: { id: input.contactId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      safeguardingFlags: {
        where: { state: 'restricted_access' },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!contact) throw new BusinessError('CONTACT_NOT_FOUND', 'Contact not found')
  if (contact.safeguardingFlags.length > 0) {
    // Restricted-access contacts (legacy safeguarding flag, ADR 0013) cannot
    // be forwarded externally. The agent should escalate through DSL.
    throw new BusinessError(
      'CONTACT_RESTRICTED',
      'Restricted contacts cannot be forwarded',
    )
  }

  let senderResult: ForwardingSenderResult
  try {
    senderResult = await input.sender({
      to: rule.toAddresses,
      cc: rule.ccAddresses,
      bcc: rule.bccAddresses,
      subject: input.subject,
      body: input.body,
    })
  } catch (err) {
    senderResult = {
      status: 'failed',
      resendId: null,
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const interactionId = createId()
  const occurredAt = new Date()
  const payload: Prisma.InputJsonObject = {
    event: 'forwarding.email_sent',
    ruleId: rule.id,
    ruleKey: rule.key,
    ruleLabel: rule.label,
    to: rule.toAddresses,
    cc: rule.ccAddresses,
    bcc: rule.bccAddresses,
    subject: input.subject,
    body: input.body,
    status: senderResult.status,
    resendId: senderResult.resendId,
    ...(senderResult.detail !== undefined ? { detail: senderResult.detail } : {}),
  }

  const summaryName = rule.label
  const summary =
    senderResult.status === 'sent'
      ? `${summaryName} → ${rule.toAddresses.join(', ')}`
      : `${summaryName} (${senderResult.status})`

  await db.interaction.create({
    data: {
      id: interactionId,
      type: 'email_forwarded',
      contactId: input.contactId,
      occurredAt,
      summary: summary.length > 160 ? `${summary.slice(0, 157)}…` : summary,
      payload,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'forwarding.email_sent',
    target: { type: 'Contact', id: input.contactId },
    before: null,
    after: {
      interactionId,
      ruleKey: rule.key,
      to: rule.toAddresses,
      cc: rule.ccAddresses,
      bcc: rule.bccAddresses,
      status: senderResult.status,
      resendId: senderResult.resendId,
    },
  })

  return {
    status: senderResult.status,
    interactionId,
    resendId: senderResult.resendId,
    ...(senderResult.detail !== undefined ? { detail: senderResult.detail } : {}),
  }
}
