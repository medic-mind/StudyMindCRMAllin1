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
  // ADR 0015: dynamic pipeline. Stage CRUD + per-family move.
  'family.pipeline_moved',
  'pipeline.stage.created',
  'pipeline.stage.updated',
  'pipeline.stage.reordered',
  'pipeline.stage.archived',
  'pipeline.stage.restored',

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
  'charge.payment_link_created',
  'finance.discrepancy_resolved',
  'gocardless.redirect_flow.created',
  'gocardless.reconcile.late_failure_recovered',

  // Envelope encryption (originally safeguarding; ADR 0013 retains these
  // for Gmail OAuth refresh-token storage and any future crypto-shred field).
  'safeguarding.field_encrypted',
  'safeguarding.field_decrypted',
  'safeguarding.break_glass',

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
  'auth.signin_succeeded',
  'auth.account_locked',
  'auth.signup_started',
  'auth.email_verified',
  'auth.email_verification_resent',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'auth.password_changed',
  'auth.session_revoked',
  'auth.sessions_revoked_all_others',
  'auth.role_granted',
  'auth.role_revoked',
  'auth.user_invited',
  'auth.user_invite_accepted',
  'auth.user_invite_resent',
  'auth.user_invite_cancelled',
  'auth.user_deactivated',
  'auth.user_reactivated',
  'auth.super_admin_seeded',
  // Audit-A2 / CLAUDE.md §20: TOTP MFA lifecycle and authn events.
  'auth.totp_setup_started',
  'auth.totp_enabled',
  'auth.totp_disabled',
  'auth.totp_failed',
  'auth.recovery_code_used',

  // OAuth (Gmail per-agent — ADR 0012)
  'gmail.oauth_connected',
  'gmail.oauth_disconnected',
  'gmail.oauth_denied',
  'gmail.oauth_scope_mismatch',
  'gmail.oauth_invalid_state',
  'gmail.oauth_needs_reconnect',

  // Audit-B2: payment links, allocations, gmail outbound, trengo connect
  'charge.payment_link_created',
  'charge.payment_link_requested',
  'finance.allocation_upserted',
  'finance.allocation_deleted',
  'finance.family_reconciled',
  'gmail.email_sent',
  'gmail.reply_requested',
  'trengo.token_connected',
  'trengo.token_connect_requested',

  // ui-completeness chunks 5/6/8: task creation, inbox triage, integration tests
  'task.assigned',
  'inbox.message_assigned',
  'inbox.message_snoozed',
  'admin.integration_tested',

  // ADR 0017: comprehensive customer view + historic backfill.
  'backfill.started',
  'backfill.completed',
  'backfill.failed',
  'backfill.cancelled',
  'interaction.recording_streamed',
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
  // ADR 0017: historic-data backfill. One bus event per provider; the worker
  // for that provider listens on its own name so we keep concurrency caps
  // isolated per integration.
  'backfill/requested',
  'backfill/gmail.requested',
  'backfill/aircall.requested',
  'backfill/trengo.requested',
  'backfill/slack.requested',
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
  'family_pipeline_moved',
  'family_billing_contact_changed',
  'safeguarding_concern_raised',
  'safeguarding_la_referral',
] as const

export type InteractionType = (typeof INTERACTION_TYPES)[number]

export function isRegisteredInteractionType(name: string): name is InteractionType {
  return (INTERACTION_TYPES as readonly string[]).includes(name)
}
