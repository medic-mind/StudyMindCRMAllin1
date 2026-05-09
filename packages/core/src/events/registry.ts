// Event taxonomy registry. See CLAUDE.md Section 45.
// Registered names are the only ones we may emit. The lint rule
// `studymind/registered-event-names` (tools/eslint-rules/registered-event-names.js)
// enforces this against `inngest.send({ name })`,
// `db.interaction.create({ data: { type } })`, and
// `writeAuditLogEntry({ action })` call sites.

/**
 * Audit + timeline event names. Dot-namespaced lower snake case.
 * (CLAUDE.md §45.1.) These are the names recorded in
 * `AuditLogEntry.action`.
 */
export const EVENT_NAMES = [
  // Contact / Family
  'contact.created',
  'contact.updated',
  'contact.merged',
  'family.created',
  'family.state_changed',
  'family.billing_contact_changed',
  'family.contact_linked',

  // Interactions
  'interaction.created',
  'interaction.deleted',

  // Calls (Aircall — CLAUDE.md §10)
  'call.started',
  'call.answered',
  'call.ended',
  'call.voicemail_left',
  'call.tagged',
  'call.commented',
  'call.transcription_added',
  'aircall.webhook_reenabled',

  // Messaging (Trengo — CLAUDE.md §11)
  'message.inbound',
  'message.outbound',
  'ticket.assigned',
  'ticket.closed',
  'ticket.reopened',
  'label.added',
  'label.removed',
  'lead.created',
  'lead.received',
  'trengo.message_sent',

  // Finance
  'payment.created',
  'payment.late_failed',
  'mandate.replaced',
  'subscription.state_changed',
  'booking.delivered',
  'booking.cancelled',
  'charge.refunded',
  'finance.discrepancy_resolved',
  'gocardless.redirect_flow.created',
  'gocardless.reconcile.late_failure_recovered',

  // Safeguarding
  'safeguarding.flag',
  'safeguarding.concern_raised',
  'safeguarding.la_referral',
  'safeguarding.restricted',
  'safeguarding.field_encrypted',
  'safeguarding.field_decrypted',
  'safeguarding.read_attempt',
  'safeguarding.break_glass',

  // Tenders / LA
  'tender.created',
  'tender.state_changed',
  'tender.draft_requested',
  'tender.draft_signed_off',
  'lacontract.created',
  'lacontract.invoice_generated',
  'lacontract.invoice_sent',
  'lacontract.invoice_paid',
  'lacontract.progress_report_drafted',
  'lacontract.progress_report_signed',
  'lacontract.progress_report_exported',
  'ap_placement.created',
  'ap_placement.review_overdue',
  'ap_placement.review_completed',
  'ap_placement.review_completed.acked',
  'tutor.session_note_added',

  // AI
  'ai.draft_generated',
  'ai.classification_completed',

  // Tasks / admin / flags
  'task.created',
  'admin.role.assign',
  'admin.role.revoke',
  'flag.toggled',
  'flag.toggled.acked',

  // Compliance
  'dsar.exported',
  'soft_delete',

  // Slack
  'slack.alert_posted',
  'slack.message_summarised',

  // System / audit
  'audit.logged',
  'system.job_completed',
  'auth.signin_failed',
] as const

export type EventName = (typeof EVENT_NAMES)[number]

export function isRegisteredEvent(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name)
}

/**
 * Inngest bus event names. These are the queue contract between webhook
 * handlers and Inngest functions, *not* audit/timeline events. Registered
 * separately so the lint rule can validate `inngest.send({ name })` call
 * sites without polluting the audit taxonomy.
 *
 * Names follow `<provider>/<event>` per the Inngest convention.
 */
export const INNGEST_EVENT_NAMES = [
  // Per-provider event ingestion
  'stripe/event.received',
  'gocardless/event.received',
  'aircall/event.received',
  'trengo/event.received',
  'asana/event.received',
  'slack/event.received',
  'gmail/event.received',
  'booking/event.received',
  'aircall/transcribe-fallback',
  'gmail/history.changed',

  // Cross-cutting domain events
  'finance/reconcile.completed',
  'finance/reconcile.family.requested',
  'ai/churn-score.requested',
  'ai/status-summary.requested',
  'compliance/retention.enforce.requested',
] as const

export type InngestEventName = (typeof INNGEST_EVENT_NAMES)[number]

export function isRegisteredInngestEvent(name: string): name is InngestEventName {
  return (INNGEST_EVENT_NAMES as readonly string[]).includes(name)
}

/**
 * Interaction.type values. Snake_case (no dots) per the existing schema
 * convention; mirrors EVENT_NAMES where they overlap so that a single
 * action can flow into both AuditLogEntry and Interaction. CLAUDE.md §45.2.
 */
export const INTERACTION_TYPES = [
  'note',
  'call',
  'message',
  'email_received',
  'email_sent',
  'booking',
  'payment',
  'system',
  'slack_summary',
  'family_state_changed',
  'family_billing_contact_changed',
  'safeguarding_concern_raised',
  'safeguarding_la_referral',
  'tender_state_changed',
  'tender_draft_signed_off',
  'lacontract_created',
  'lacontract_invoice_generated',
  'lacontract_invoice_sent',
  'lacontract_invoice_paid',
  'lacontract_progress_report_signed',
  'tutor_session_note',
] as const

export type InteractionType = (typeof INTERACTION_TYPES)[number]

export function isRegisteredInteractionType(name: string): name is InteractionType {
  return (INTERACTION_TYPES as readonly string[]).includes(name)
}
