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
  // ADR 0018: multi-board cards. Board + card + label + subject lifecycle.
  'board.created',
  'board.updated',
  'board.archived',
  'card.created',
  'card.moved',
  'card.updated',
  'card.archived',
  'card.commented',
  'card.description_changed',
  // Per-board configurable quick-action buttons (Called once, Called
  // twice, Call completed, …). Manager+ manages the catalogue; anyone
  // with card-write can fire one.
  'board.quick_action_created',
  'board.quick_action_updated',
  'board.quick_action_archived',
  'board.quick_action_restored',
  'card.quick_action_applied',
  // Call summary on a card (slice B): an agent records the outcome of a call
  // and can fan it out to Slack / Trengo / email.
  'card.call_summary_added',
  'card.call_summary_sent',
  'label.created',
  'label.updated',
  'label.deleted',
  'subject.created',

  // Branding (CLAUDE.md §4). Custom logo upload/removal — settings.write tier.
  'branding.logo_updated',
  'branding.logo_removed',

  // Contact links (parent/student, sibling, caseworker, etc) — many-to-many
  // between contacts. Reciprocal links count as one event per side.
  'contact.link_added',
  'contact.link_removed',
  // Contact documents (small attachments stored in Postgres).
  'contact.document_added',
  'contact.document_removed',
  // Call summary on a contact (not a card) + multi-channel fan-out.
  'contact.call_summary_added',
  'contact.call_summary_sent',
  // Mailchimp audience push (CLAUDE.md §16).
  'contact.mailchimp_pushed',

  // Sister-brand companies (CLAUDE.md §4). Admin-editable from Settings.
  'company.created',
  'company.updated',
  'company.archived',
  'company.restored',

  // Teams (internal ops squads).
  'team.created',
  'team.updated',
  'team.archived',
  'team.restored',
  'team.member_added',
  'team.member_removed',
  'task.team_changed',

  // Internal team messaging (ADR 0022). Channel administration is audited;
  // individual messages are high-volume staff↔staff chat and are deliberately
  // NOT written to the compliance AuditLog or the customer timeline.
  'chat.channel_created',
  'chat.channel_updated',
  'chat.channel_archived',
  'chat.channel_restored',
  'chat.channel_deleted',
  'chat.member_added',
  'chat.member_removed',

  // Forwarding (Settings → Forwarding): configurable "Forward to <team>"
  // quick actions on a contact. Rule CRUD is Manager+; sending is
  // Sales Executive+.
  'forwarding.rule_created',
  'forwarding.rule_updated',
  'forwarding.rule_archived',
  'forwarding.rule_restored',
  'forwarding.email_sent',

  // B2B accounts (Schools + Partnerships) — tracked organisations we work
  // with. CRUD is Manager+; viewing is all roles.
  'business_account.created',
  'business_account.updated',
  'business_account.archived',
  'business_account.restored',
  'business_account.contact_linked',
  'business_account.contact_unlinked',
  // Students enrolled at a BusinessAccount.
  'business_account.student_added',
  'business_account.student_updated',
  'business_account.student_archived',

  // Call summary templates (Settings → Call summary templates). Admin
  // catalogue used to prefill the contact page Call Summary panel.
  'call_summary_template.created',
  'call_summary_template.updated',
  'call_summary_template.archived',
  'call_summary_template.restored',
  'call_summary_template.pdf_attached',
  'call_summary_template.pdf_removed',

  // Uploaded invoices — manually uploaded invoice files attached to a
  // BusinessAccount / Contact / Family. Different from the finance-mirrored
  // Invoice rows.
  'uploaded_invoice.created',
  'uploaded_invoice.updated',
  'uploaded_invoice.archived',
  'uploaded_invoice.restored',
  'uploaded_invoice.deleted',

  // B2B Invoices Platform sync (b2b.studymind.co.uk). Outbound writes, inbound
  // mirror upserts, and config/connection management. CLAUDE.md §2, §6, §21.
  'invoicing.config_updated',
  'invoicing.connection_tested',
  'invoicing.customer_pushed',
  'invoicing.customer_synced',
  'invoicing.invoice_raised',
  'invoicing.invoice_sent',
  'invoicing.invoice_synced',
  'invoicing.payment_recorded',
  'invoicing.payment_synced',
  'invoicing.invoice_marked_paid',
  // Backfill → real School / B2B Partner accounts, auto-classification, and the
  // Unsorted tray (one-click classify). CLAUDE.md §2 (idempotent), §6.
  'invoicing.accounts_imported',
  'invoicing.account_classified',

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
  // Manual click-to-call log (Aircall fallback / Google Voice / freeform).
  'call.manually_logged',

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

  // Dynamic lead ingestion + classification (ADR 0023). The universal
  // /api/leads endpoint normalises any Contact-Form-7 payload; an Inngest job
  // classifies (brand / products / categories / score) and routes onto the
  // Sales Pipeline, deduping re-enquiries onto the existing contact.
  'lead.classified',
  'lead.converted',
  'lead.reenquiry_recorded',
  'lead.dismissed',
  'lead.classification_corrected',
  'lead.source_created',
  'lead.source_updated',
  'lead.source_archived',
  'lead.rule_created',
  'lead.rule_updated',
  'lead.rule_archived',
  'lead.product_created',
  'lead.product_updated',
  'lead.product_archived',

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
  'task.updated',
  'task.closed',
  'task.commented',
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
  // User management (admin-created accounts + grantable user.manage permission).
  'auth.user_created',
  'auth.user_updated',
  'auth.password_reset_by_admin',
  'auth.permission_granted',
  'auth.permission_revoked',
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

  // Communications Hub — multi-account mail (ADR 0021). MailAccount lifecycle
  // (personal + shared team inboxes) and shared-inbox membership. Reuses the
  // existing Gmail sync via the GmailMailbox bridge; secrets stay in
  // EncryptedField (§21).
  'mail_account.created',
  'mail_account.imported',
  'mail_account.updated',
  'mail_account.disconnected',
  'mail_account.default_changed',
  'mail_account.member_added',
  'mail_account.member_removed',
  // ADR 0021 Phase 5 — two-way action sync. A CRM action mutates the live
  // mailbox (read/archive/star/trash/label), mirrored to Gmail and reflected on
  // the Conversation head. All reversible (trash → Gmail Trash, recoverable).
  'mail.thread_read_changed',
  'mail.thread_archived',
  'mail.thread_starred',
  'mail.thread_trashed',
  'mail.thread_labeled',
  // ADR 0021 Phase 4 — reply to / compose an email from the CRM (reuse the
  // Gmail sendReply / sendEmail outbound, which additionally write
  // gmail.email_sent).
  'mail.thread_replied',
  'mail.composed',
  // ADR 0021 Phase 6 — internal notes + @mentions on a conversation (shared
  // team inboxes). Notes are staff↔staff and never sent outbound; a mention
  // writes an audit row targeting the colleague so it surfaces in their
  // notifications.
  'conversation.note_added',
  'conversation.note_mentioned',

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
  // CRM → Trengo outbound reply (procedure-level record; the integration
  // additionally writes `trengo.message_sent` on success). Mirrors the Gmail
  // `*.reply_requested` shape.
  'trengo.reply_requested',
  // CRM → Trengo ticket state changes. Audited at the integration layer once
  // the PATCH succeeds; the webhook echo is then linked onto the same
  // Interaction (jobs.ts linkCrmOutboundEcho) rather than duplicated.
  'trengo.ticket_close_requested',
  'trengo.ticket_reopen_requested',
  // ADR 0020 Phase 6e — assignment from the CRM (drives Trengo assignTicket).
  'trengo.ticket_assign_requested',

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
  // ADR 0020 Phase 2c: one-shot Conversation-head backfill. Distinct from
  // provider backfills (which fill Interaction) — this re-derives queryable
  // state from rows we already have.
  'migration.conversation_head_backfill_requested',
  'migration.conversation_head_backfill_started',
  'migration.conversation_head_backfill_completed',
  // ADR 0020 Phase 6c — contact-field suggestions from upstream providers.
  // We NEVER silent-merge (CLAUDE.md §3); these events track the human
  // review of a Trengo `contact.updated` (or other source).
  'contact.suggestion_created',
  'contact.suggestion_accepted',
  'contact.suggestion_rejected',
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
  // B2B Invoices Platform sync. One bus event per inbound webhook (processed
  // async like every other provider), plus the nightly events-feed reconcile.
  'invoicing/event.received',
  'invoicing/reconcile.requested',
  // Admin-triggered one-shot backfill: pull every B2B customer into real CRM
  // accounts. Idempotent; safe to re-run.
  'invoicing/accounts.import.requested',
  // ADR 0020 Phase 2c — one-shot conversation-head backfill. Self-recursive
  // (the function reschedules with a cursor) so a single Inngest event name
  // covers the initial trigger and every continuation.
  'migration/backfill-conversation-heads.requested',
  // ADR 0020 Phase 6d — fan out attachment downloads off the webhook.
  // Concurrency capped on the worker (4) so a burst of attachments doesn't
  // starve the rest of the queue.
  'trengo/download-attachments.requested',
  // Dynamic lead ingestion (ADR 0023): the universal /api/leads endpoint
  // persists a Lead then hands off async classification + pipeline routing.
  'lead/classify.requested',
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
  // Trengo ticket / label lifecycle (CLAUDE.md §11). These are written by the
  // Trengo webhook job (packages/integrations/trengo/src/jobs.ts) and exist in
  // the Prisma InteractionType enum; registered here so the taxonomy and the
  // schema agree.
  'ticket_assigned',
  'ticket_closed',
  'ticket_reopened',
  'label_added',
  'label_removed',
  'family_state_changed',
  'family_pipeline_moved',
  'card_moved',
  'family_billing_contact_changed',
  'safeguarding_concern_raised',
  'safeguarding_la_referral',
  // Card detail modal: comment thread + inline description. Comments persist
  // as Interactions on the backing Contact so they appear in the customer's
  // history.
  'card_comment',
  'card_description_changed',
  // Universal task comment thread (slice B). Persisted on the linked contact
  // when the task has one, else on the task itself.
  'task_comment',
  // Call summary on a board card (slice B). The summary itself and the record
  // of fanning it out to Slack / Trengo / email both persist on the backing
  // Contact.
  'call_summary',
  'call_summary_sent',
  // Forwarding quick action: agent forwarded a query about this contact to
  // an internal address (AP team, CEOs, schools, partnerships, etc).
  'email_forwarded',
  // ADR 0023: a web enquiry captured via the universal /api/leads endpoint.
  // First contact and every re-enquiry land on the contact's timeline so the
  // page shows how many times they have reached out.
  'lead_enquiry',
] as const

export type InteractionType = (typeof INTERACTION_TYPES)[number]

export function isRegisteredInteractionType(name: string): name is InteractionType {
  return (INTERACTION_TYPES as readonly string[]).includes(name)
}
