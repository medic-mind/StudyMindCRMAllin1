// Interaction (timeline) types. See CLAUDE.md Section 6.2 and Section 45.

import { z } from 'zod'

export const InteractionType = z.enum([
  'note',
  'call_logged',
  'email_sent',
  'email_received',
  'family.state_changed',
  'family.billing_contact_changed',
  'safeguarding.concern_raised',
  // Bookings: booking.studymind.co.uk lessons (§15) and Summer Camp bookings
  // (camp.studymind.co.uk). Both are DB `booking` interactions, distinguished
  // by `payload.kind`; the timeline chip reads "booking" rather than "note".
  'booking',
  // Calls (Aircall — §10).
  'call.started',
  'call.answered',
  'call.ended',
  'call.voicemail_left',
  'call.tagged',
  'call.commented',
  'call.transcription_added',
  // Messaging (Trengo — §11).
  'message.inbound',
  'message.outbound',
  'ticket.assigned',
  'ticket.closed',
  'ticket.reopened',
  'label.added',
  'label.removed',
  // DB-aligned display types (Prisma InteractionType values passed through by
  // interaction.list so the Activity timeline can label rows truthfully —
  // previously every unmapped type collapsed to 'note' and the timeline lied).
  'call',
  'message',
  'ticket_assigned',
  'ticket_closed',
  'ticket_reopened',
  'label_added',
  'label_removed',
  'card_moved',
  'card_comment',
  'card_description_changed',
  'call_summary',
  'call_summary_sent',
  'task_comment',
  'lead_enquiry',
  'email_forwarded',
  'slack_summary',
  'payment',
  'family_pipeline_moved',
])
export type InteractionType = z.infer<typeof InteractionType>

export const Interaction = z.object({
  id: z.string(),
  type: InteractionType,
  contactId: z.string().nullable(),
  familyId: z.string().nullable(),
  occurredAt: z.date(),
  summary: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
})
export type Interaction = z.infer<typeof Interaction>

export const InteractionCreateInput = z
  .object({
    type: InteractionType.default('note'),
    contactId: z.string().optional(),
    familyId: z.string().optional(),
    occurredAt: z.date().optional(),
    summary: z.string().trim().min(1).max(500),
    body: z.string().trim().min(1).max(5000),
  })
  .refine((v) => !!v.contactId || !!v.familyId, {
    message: 'An interaction must reference at least one of contactId or familyId',
    path: ['contactId'],
  })
export type InteractionCreateInput = z.infer<typeof InteractionCreateInput>

/** Display hints derived from the payload at list time so the timeline can
 *  label rows truthfully (call direction/duration, message channel + send
 *  state, …) without shipping the raw JSONB payload to the client. */
export const InteractionListMeta = z.object({
  /** trengo/email channel (whatsapp | sms | email | web_chat) when known. */
  channel: z.string().nullable(),
  /** Call direction (inbound | outbound) when the row is a call. */
  direction: z.string().nullable(),
  /** Call duration in seconds when known. */
  durationSec: z.number().nullable(),
  /** Outbound send state (pending_send | sent | failed) when applicable. */
  status: z.string().nullable(),
  /** Human-readable last send error, when the row is a failed outbound. */
  error: z.string().nullable(),
})
export type InteractionListMeta = z.infer<typeof InteractionListMeta>

export const InteractionListItem = z.object({
  id: z.string(),
  type: InteractionType,
  occurredAt: z.date(),
  summary: z.string().nullable(),
  authorId: z.string().nullable(),
  contactId: z.string().nullable(),
  familyId: z.string().nullable(),
  meta: InteractionListMeta.optional(),
})
export type InteractionListItem = z.infer<typeof InteractionListItem>

/**
 * Type-tagged payload shapes per InteractionType. The DB column is JSONB; this
 * registry validates writes and reads at the boundary.
 */
export const NotePayload = z.object({
  body: z.string().min(1),
})
export type NotePayload = z.infer<typeof NotePayload>

export const FamilyBillingContactChangedPayload = z.object({
  previousContactId: z.string().nullable(),
  newContactId: z.string(),
  reason: z.string(),
  effectiveDate: z.date().nullable(),
})
export type FamilyBillingContactChangedPayload = z.infer<typeof FamilyBillingContactChangedPayload>
