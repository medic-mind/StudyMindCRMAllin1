// Contact domain types. Single source of truth — used by tRPC inputs/outputs,
// React Hook Form schemas, and DB serialisation. See CLAUDE.md Sections 6.1, 30.

import { z } from 'zod'

/** UK and international phone numbers, stored E.164. */
export const E164 = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/u, 'Phone must be in E.164 format, e.g. +447700900123')

export const Email = z.string().email().max(254)

export const ContactKind = z.enum(['parent', 'student', 'tutor', 'la_caseworker', 'other'])
export type ContactKind = z.infer<typeof ContactKind>

const NameField = z
  .string()
  .trim()
  .min(1)
  .max(120)

export const Contact = z.object({
  id: z.string(),
  kind: ContactKind,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  dateOfBirth: z.date().nullable(),
  isMinor: z.boolean(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
})
export type Contact = z.infer<typeof Contact>

/** Compact list view used by list pages. */
/** Shape of a Company exposed through view-models — id + presentation. */
export const CompanyRef = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string().nullable(),
})
export type CompanyRef = z.infer<typeof CompanyRef>

export const ContactSummary = z.object({
  id: z.string(),
  kind: ContactKind,
  displayName: z.string(),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  familyId: z.string().nullable(),
  familyName: z.string().nullable(),
  lastInteractionAt: z.date().nullable(),
  company: CompanyRef.nullable(),
})
export type ContactSummary = z.infer<typeof ContactSummary>

// Extended profile (additive). All optional; new contacts can still be
// created with just kind + a name.
export const ContactSendStatus = z.enum([
  'none',
  'send_support',
  'ehcp_in_place',
  'ehcp_in_progress',
  'other',
])
export type ContactSendStatus = z.infer<typeof ContactSendStatus>

export const ContactLinkRelation = z.enum([
  'parent_of',
  'child_of',
  'guardian_of',
  'sibling_of',
  'spouse_of',
  'partner_of',
  'caseworker_for',
  'tutor_of',
  'student_of',
  'other',
])
export type ContactLinkRelation = z.infer<typeof ContactLinkRelation>

/** Inverse of each relation — used when we auto-create the reciprocal link. */
export const INVERSE_RELATION: Record<ContactLinkRelation, ContactLinkRelation> = {
  parent_of: 'child_of',
  child_of: 'parent_of',
  guardian_of: 'child_of',
  sibling_of: 'sibling_of',
  spouse_of: 'spouse_of',
  partner_of: 'partner_of',
  caseworker_for: 'student_of',
  tutor_of: 'student_of',
  student_of: 'tutor_of',
  other: 'other',
}

const OptionalShort = z.string().trim().min(1).max(120).optional()
const OptionalLong = z.string().trim().min(1).max(2000).optional()

const ProfileFields = {
  addressLine1: OptionalShort,
  addressLine2: OptionalShort,
  city: OptionalShort,
  postcode: OptionalShort,
  country: OptionalShort,
  schoolName: OptionalShort,
  yearGroup: OptionalShort,
  sendStatus: ContactSendStatus.optional(),
  jobTitle: OptionalShort,
  pronouns: z.string().trim().min(1).max(40).optional(),
  mailchimpEmail: Email.optional(),
  companyId: z.string().min(1).optional(),
} as const

export const ContactCreateInput = z.object({
  kind: ContactKind,
  firstName: NameField.optional(),
  lastName: NameField.optional(),
  email: Email.optional(),
  phoneE164: E164.optional(),
  dateOfBirth: z.date().optional(),
  notes: OptionalLong,
  ...ProfileFields,
})
export type ContactCreateInput = z.infer<typeof ContactCreateInput>

export const ContactUpdateInput = z.object({
  id: z.string(),
  firstName: NameField.nullish(),
  lastName: NameField.nullish(),
  email: Email.nullish(),
  phoneE164: E164.nullish(),
  dateOfBirth: z.date().nullish(),
  notes: z.string().max(2000).nullish(),
  addressLine1: z.string().trim().max(120).nullish(),
  addressLine2: z.string().trim().max(120).nullish(),
  city: z.string().trim().max(120).nullish(),
  postcode: z.string().trim().max(120).nullish(),
  country: z.string().trim().max(120).nullish(),
  schoolName: z.string().trim().max(120).nullish(),
  yearGroup: z.string().trim().max(120).nullish(),
  sendStatus: ContactSendStatus.nullish(),
  jobTitle: z.string().trim().max(120).nullish(),
  pronouns: z.string().trim().max(40).nullish(),
  mailchimpEmail: Email.nullish(),
  companyId: z.string().nullish(),
})
export type ContactUpdateInput = z.infer<typeof ContactUpdateInput>

/** True if the contact is under 18 today. */
export function isMinorByDob(dob: Date | null | undefined, now = new Date()): boolean {
  if (!dob) return false
  const eighteenAgo = new Date(now)
  eighteenAgo.setFullYear(now.getFullYear() - 18)
  return dob > eighteenAgo
}

export function displayNameOf(c: {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}): string {
  const fn = (c.firstName ?? '').trim()
  const ln = (c.lastName ?? '').trim()
  const joined = [fn, ln].filter(Boolean).join(' ')
  if (joined) return joined
  if (c.email) return c.email
  return 'Unnamed contact'
}
