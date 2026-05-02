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
export const ContactSummary = z.object({
  id: z.string(),
  kind: ContactKind,
  displayName: z.string(),
  email: z.string().nullable(),
  phoneE164: z.string().nullable(),
  familyId: z.string().nullable(),
  familyName: z.string().nullable(),
  lastInteractionAt: z.date().nullable(),
})
export type ContactSummary = z.infer<typeof ContactSummary>

export const ContactCreateInput = z.object({
  kind: ContactKind,
  firstName: NameField.optional(),
  lastName: NameField.optional(),
  email: Email.optional(),
  phoneE164: E164.optional(),
  dateOfBirth: z.date().optional(),
  notes: z.string().max(2000).optional(),
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
