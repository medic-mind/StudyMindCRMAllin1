// Break-glass alert reporter. CLAUDE.md §21.1.
//
// When `decryptFieldById` is invoked with break-glass metadata, the audited
// path writes the `safeguarding.break_glass` audit row and then calls this
// reporter. The reporter fans out to:
//   1. Slack #crm-safeguarding-alerts via postAlert (no plaintext).
//   2. PagerDuty (Sev-2 / "error") for on-call DSL escalation.
//   3. Resend email to the DPO.
//
// All three are best-effort with safeFetch + structured errors. The audit
// is the source of truth — alert delivery failures are logged but do not
// prevent the underlying decrypt from completing. CLAUDE.md §21.1 frames
// the audit as the non-negotiable; the alerts are the human-facing layer.

import { flag } from '@studymind/core/flags'
import { triggerEvent } from '@studymind/integration-pagerduty/client'
import { sendEmail } from '@studymind/integration-resend/client'
import { postAlert } from '@studymind/integration-slack/outbound'
import type { BreakGlassAlert, BreakGlassReporter } from '@studymind/core/safeguarding'

function safeguardingChannelId(): string | null {
  return process.env['SLACK_SAFEGUARDING_CHANNEL_ID'] ?? null
}

function dpoEmail(): string | null {
  return process.env['DPO_EMAIL'] ?? null
}

/**
 * Build the human message. Does NOT contain plaintext. Mentions the
 * EncryptedField id, the column, the actor, the assigned DSL we expected,
 * and the request id for traceability.
 */
function buildMessage(alert: BreakGlassAlert): string {
  return [
    `BREAK-GLASS safeguarding decrypt`,
    `actor=${alert.actorId ?? 'unknown'}`,
    `roles=[${alert.actorRoles.join(',')}]`,
    `expected_dsl=${alert.assignedDslUserId ?? 'none'}`,
    `field=${alert.encryptedFieldId} column=${alert.column}`,
    `purpose="${alert.purpose}"`,
    `request_id=${alert.requestId ?? 'none'}`,
    `kms_call=${alert.kmsCallId}`,
  ].join(' | ')
}

export const breakGlassReporter: BreakGlassReporter = async (alert) => {
  // Operational kill-switch — disabling silences alerts but the audit row
  // is already written. Toggling writes its own audit entry.
  const enabled = await flag('safeguarding.dsl_break_glass_alert')
  if (!enabled) return

  const message = buildMessage(alert)

  // 1. Slack — #crm-safeguarding-alerts (separate from #crm-alerts).
  const channelId = safeguardingChannelId()
  if (channelId) {
    try {
      await postAlert({
        channelId,
        message,
        idempotencyKey: `break-glass:${alert.kmsCallId}`,
        ctx: {
          actorId: 'system',
          requestId: alert.requestId ?? alert.kmsCallId,
        },
      })
    } catch (err) {
      console.error('break-glass.slack_failed', err)
    }
  }

  // 2. PagerDuty — Sev-2 (error). Dedup on kmsCallId so retries collapse.
  try {
    await triggerEvent({
      summary: `Safeguarding break-glass by ${alert.actorId ?? 'unknown'}`,
      severity: 'error',
      dedupKey: `break-glass:${alert.kmsCallId}`,
      source: 'studymind-crm-safeguarding',
      details: {
        actorId: alert.actorId,
        actorRoles: alert.actorRoles,
        contactId: alert.contactId,
        column: alert.column,
        encryptedFieldId: alert.encryptedFieldId,
        assignedDslUserId: alert.assignedDslUserId,
        requestId: alert.requestId,
        purpose: alert.purpose,
      },
    })
  } catch (err) {
    console.error('break-glass.pagerduty_failed', err)
  }

  // 3. Resend email to the DPO.
  const dpo = dpoEmail()
  if (dpo) {
    try {
      await sendEmail({
        to: dpo,
        subject: `Safeguarding break-glass: ${alert.column} accessed by ${alert.actorId ?? 'unknown'}`,
        body: [
          'A safeguarding decrypt was performed under break-glass authority.',
          '',
          message,
          '',
          'No plaintext is included. Inspect the AuditLogEntry for full details.',
          `Audit target: EncryptedField ${alert.encryptedFieldId}`,
        ].join('\n'),
      })
    } catch (err) {
      console.error('break-glass.email_failed', err)
    }
  }
}
