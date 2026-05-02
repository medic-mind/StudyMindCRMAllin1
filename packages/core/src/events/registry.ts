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
  'tender.state_changed',
  'lacontract.created',

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
