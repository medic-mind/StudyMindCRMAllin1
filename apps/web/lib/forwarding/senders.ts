// Real sender for the forwarding orchestrator. The domain layer
// (packages/core) cannot import integration clients, so the tRPC layer
// supplies this. System email is sent via Gmail (Google OAuth) — these
// forwards go to internal team addresses.
//
// CLAUDE.md §14 (Gmail OAuth for outbound mail) and §27 (orchestration via core).

import { sendSystemEmail } from '@studymind/integration-gmail/system-send'

import type { ForwardingSender } from '@studymind/core/forwarding'

interface BuildArgs {
  agentEmail: string
}

/**
 * Build the live sender. Returns `skipped` when no system Gmail mailbox is
 * connected — callers don't have to special-case that; the orchestrator
 * records a skipped Interaction with the detail and the agent sees a clear
 * toast. The message is sent from the configured system mailbox
 * (SYSTEM_GMAIL_EMAIL, e.g. info@studymind.co.uk).
 */
export function buildForwardingSender(_args: BuildArgs): ForwardingSender {
  return async ({ to, cc, bcc, subject, body }) => {
    if (to.length === 0) {
      return { status: 'skipped', resendId: null, detail: 'No recipients configured' }
    }
    const result = await sendSystemEmail({
      to,
      cc: cc.length > 0 ? cc : undefined,
      bcc: bcc.length > 0 ? bcc : undefined,
      subject,
      text: body,
    })
    if (result.status === 'sent') {
      // `resendId` is the legacy persisted payload key (CLAUDE.md §19
      // forward-only). It now carries the Gmail message id.
      return { status: 'sent', resendId: result.id }
    }
    if (result.status === 'skipped') {
      return {
        status: 'skipped',
        resendId: null,
        detail: result.detail ?? 'No Gmail mailbox connected',
      }
    }
    return { status: 'failed', resendId: null, detail: result.detail ?? 'Send failed' }
  }
}
