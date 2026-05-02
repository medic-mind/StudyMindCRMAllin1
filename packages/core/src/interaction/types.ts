// Interaction (timeline) types. See CLAUDE.md Section 6.2 and Section 45.

import { z } from 'zod'

export const InteractionType = z.enum([
  'note',
  'call_logged',
  'email_sent',
  'family.state_changed',
  'family.billing_contact_changed',
  'safeguarding.concern_raised',
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

export const InteractionListItem = z.object({
  id: z.string(),
  type: InteractionType,
  occurredAt: z.date(),
  summary: z.string().nullable(),
  authorId: z.string().nullable(),
  contactId: z.string().nullable(),
  familyId: z.string().nullable(),
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
