// Event taxonomy registry. See CLAUDE.md Section 45.
// Registered names are the only ones we may emit.

export const EVENT_NAMES = [
  // Contact / Family
  'contact.created',
  'contact.updated',
  'family.state_changed',
  'family.billing_contact_changed',

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

  // Messaging (Trengo — CLAUDE.md §11)
  'message.inbound',
  'message.outbound',
  'ticket.assigned',
  'ticket.closed',
  'ticket.reopened',
  'label.added',
  'label.removed',
  'lead.created',

  // Finance
  'payment.created',
  'payment.late_failed',
  'mandate.replaced',
  'subscription.state_changed',
  'booking.delivered',
  'booking.cancelled',

  // Safeguarding
  'safeguarding.concern_raised',
  'safeguarding.la_referral',
  'safeguarding.restricted',

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
  'ap_placement.created',
  'ap_placement.review_overdue',
  'ap_placement.review_completed',
  'tutor.session_note_added',

  // AI
  'ai.draft_generated',
  'ai.classification_completed',

  // System / audit
  'audit.logged',
  'system.job_completed',
] as const

export type EventName = (typeof EVENT_NAMES)[number]

export function isRegisteredEvent(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name)
}
