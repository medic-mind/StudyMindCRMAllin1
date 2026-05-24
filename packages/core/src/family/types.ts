// Family domain types. See CLAUDE.md Sections 6.1, 41.1.

import { z } from 'zod'

export const FamilyState = z.enum(['lead', 'trial', 'active', 'at_risk', 'churned'])
export type FamilyState = z.infer<typeof FamilyState>

export const BillingParty = z.enum(['family', 'local_authority'])
export type BillingParty = z.infer<typeof BillingParty>

export const Family = z.object({
  id: z.string(),
  name: z.string().nullable(),
  state: FamilyState,
  billingParty: BillingParty,
  billingContactId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
})
export type Family = z.infer<typeof Family>

export const FamilyCreateInput = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  billingContactId: z.string().optional(),
  billingParty: BillingParty.default('family'),
})
export type FamilyCreateInput = z.infer<typeof FamilyCreateInput>

export const FamilyMemberRole = z.enum(['billing', 'student', 'guardian', 'other'])
export type FamilyMemberRole = z.infer<typeof FamilyMemberRole>

export const FamilyLinkContactInput = z.object({
  familyId: z.string(),
  contactId: z.string(),
  role: FamilyMemberRole,
})
export type FamilyLinkContactInput = z.infer<typeof FamilyLinkContactInput>

export const FamilySetBillingContactInput = z.object({
  familyId: z.string(),
  newBillingContactId: z.string(),
  reason: z.string().trim().min(3).max(500),
  effectiveDate: z.date().optional(),
})
export type FamilySetBillingContactInput = z.infer<typeof FamilySetBillingContactInput>
