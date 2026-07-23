// Additional points of contact (ContactChannel) — validation + tidy helpers.
// The primary Contact.email / Contact.phoneE164 stay the matching source of
// truth (§16, §10); these capture extra ways to reach a contact (a second
// mobile, a work email, a WhatsApp/Instagram handle). Pure — the tRPC router
// (`contact.points.*`) and any importer share these.

import { z } from 'zod'

export const ContactPointKind = z.enum(['email', 'phone', 'other'])
export type ContactPointKind = z.infer<typeof ContactPointKind>

const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** Tidy a value by kind: emails are lowercased; phones/other are trimmed. The
 *  UI enters phones via <PhoneInput> so they already arrive E.164. */
export function normaliseContactPointValue(kind: ContactPointKind, value: string): string {
  const v = value.trim()
  return kind === 'email' ? v.toLowerCase() : v
}

export const ContactPointCreateInput = z
  .object({
    contactId: z.string().min(1),
    kind: ContactPointKind,
    value: z.string().trim().min(1).max(320),
    label: z.string().trim().max(120).nullish(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === 'email' && !emailLike.test(val.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid email address', path: ['value'] })
    }
  })
export type ContactPointCreateInput = z.infer<typeof ContactPointCreateInput>

export const ContactPointUpdateInput = z.object({
  id: z.string().min(1),
  value: z.string().trim().min(1).max(320).optional(),
  label: z.string().trim().max(120).nullish(),
})
export type ContactPointUpdateInput = z.infer<typeof ContactPointUpdateInput>

export const ContactPointRemoveInput = z.object({ id: z.string().min(1) })
