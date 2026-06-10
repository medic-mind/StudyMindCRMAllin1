// Direct Debit setup-link emails (ADR 0038 amendment). Shared by the tRPC
// send/resend procedures and the automated reminder cron, so every path
// renders the same template, stamps the same automation state, and leaves the
// same timeline Interaction. Sent from the configured system Gmail mailbox
// (CLAUDE.md §14 — never Resend).

import { createId } from '@paralleldrive/cuid2'

import { markSetupLinkEmailed } from '@studymind/core/finance'
import {
  buildDirectDebitReminderEmail,
  buildDirectDebitSetupEmail,
} from '@studymind/core/email'
import { sendSystemEmail } from '@studymind/integration-gmail/system-send'

import { db } from '@/lib/db'

const DAY_MS = 24 * 60 * 60 * 1000

export interface SetupLinkEmailInput {
  kind: 'initial' | 'reminder'
  link: {
    id: string
    token: string
    description: string | null
    expiresAt: Date
    contactId: string
    familyId: string
  }
  to: string
  firstName?: string | null
  /** Agent who triggered the send; null for the automated reminder. */
  actorId: string | null
  now?: Date
}

export interface SetupLinkEmailResult {
  status: 'sent' | 'skipped' | 'failed'
  detail?: string
}

export function buildSetupLinkUrl(token: string): string {
  const appUrl = (process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000').replace(
    /\/$/,
    '',
  )
  return `${appUrl}/api/gocardless/setup/${token}`
}

export async function sendSetupLinkEmail(
  input: SetupLinkEmailInput,
): Promise<SetupLinkEmailResult> {
  const now = input.now ?? new Date()
  const setupUrl = buildSetupLinkUrl(input.link.token)
  const daysRemaining = Math.max(
    1,
    Math.floor((input.link.expiresAt.getTime() - now.getTime()) / DAY_MS),
  )

  const rendered =
    input.kind === 'initial'
      ? buildDirectDebitSetupEmail({
          firstName: input.firstName ?? null,
          setupUrl,
          description: input.link.description,
          validForDays: daysRemaining,
        })
      : buildDirectDebitReminderEmail({
          firstName: input.firstName ?? null,
          setupUrl,
          description: input.link.description,
          validForDays: daysRemaining,
          daysRemaining,
        })

  const result = await sendSystemEmail({
    to: input.to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  })

  if (result.status !== 'sent') {
    return {
      status: result.status,
      detail: result.detail ?? 'No system Gmail mailbox connected',
    }
  }

  await markSetupLinkEmailed(db, input.link.id, { to: input.to, kind: input.kind, now })

  // Timeline record on the contact (type `payment`, like every Direct Debit
  // moment) — so the agent can see the ask and the chase next to the money.
  await db.interaction.create({
    data: {
      id: createId(),
      type: 'payment',
      contactId: input.link.contactId,
      familyId: input.link.familyId,
      occurredAt: now,
      summary:
        input.kind === 'initial'
          ? 'Direct Debit setup link emailed'
          : 'Direct Debit setup reminder emailed',
      payload: {
        source: 'gocardless_dd',
        setupLinkId: input.link.id,
        emailTo: input.to,
        kind: input.kind,
        gmailMessageId: result.id,
      },
      createdById: input.actorId,
      updatedById: input.actorId,
    },
  })

  return { status: 'sent' }
}
