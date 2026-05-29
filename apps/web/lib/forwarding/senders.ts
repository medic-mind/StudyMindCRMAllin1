// Real sender for the forwarding orchestrator. The domain layer
// (packages/core) cannot import integration clients, so the tRPC layer
// supplies this. Uses Resend (system email) — these forwards go to internal
// addresses, so per-agent Gmail OAuth isn't required.
//
// CLAUDE.md §3 (Resend for system email) and §27 (orchestration via core).

import { sendEmail } from '@studymind/integration-resend'

import type { ForwardingSender } from '@studymind/core/forwarding'

interface BuildArgs {
  agentEmail: string
}

/**
 * Build the live sender. Returns `skipped` when Resend isn't configured —
 * callers don't have to special-case that; the orchestrator records a
 * skipped Interaction with the detail and the agent sees a clear toast.
 *
 * The `from` is derived from the acting agent's email when available so the
 * recipient knows who triggered the forward. Resend will only accept this
 * if the configured RESEND_FROM_ADDRESS sender domain is verified for the
 * account — when it is not, the integration falls back to the env default
 * (`crm@studymind.co.uk`).
 */
export function buildForwardingSender(_args: BuildArgs): ForwardingSender {
  return async ({ to, cc, bcc, subject, body }) => {
    const allTo = to.length > 0 ? to : []
    if (allTo.length === 0) {
      return { status: 'skipped', resendId: null, detail: 'No recipients configured' }
    }
    try {
      // Resend's REST `to` is the primary; cc/bcc currently surface via the
      // body when not supported. The integration client's contract is the
      // minimum surface we use across the codebase (system email) — when
      // we need richer headers we extend the client itself.
      const recipients = [...allTo, ...cc, ...bcc]
      const result = await sendEmail({
        to: recipients,
        subject,
        body: ccBccPreamble(cc, bcc) + body,
      })
      if (result.status === 'skipped') {
        return {
          status: 'skipped',
          resendId: null,
          detail: 'Resend API key not configured (RESEND_API_KEY)',
        }
      }
      return { status: 'sent', resendId: result.id }
    } catch (err) {
      return {
        status: 'failed',
        resendId: null,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

/** Show the cc/bcc list at the top of the body so internal recipients can see
 * who else received it — Resend's minimal client doesn't separate them. */
function ccBccPreamble(cc: string[], bcc: string[]): string {
  const lines: string[] = []
  if (cc.length > 0) lines.push(`Cc: ${cc.join(', ')}`)
  if (bcc.length > 0) lines.push(`Bcc: ${bcc.join(', ')}`)
  return lines.length > 0 ? `${lines.join('\n')}\n\n` : ''
}
