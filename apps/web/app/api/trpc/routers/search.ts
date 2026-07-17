// Global search router. CLAUDE.md §20 (auth-gated), §27 (Zod input, view-
// model output, cursor-less because we cap at 10 per type and rank in DB).
//
// Powers the top-bar command palette: a single query string returns up to
// 10 Contacts (by name/email/phone) and up to 10 Families (by billing
// contact name or family name). We do NOT include restricted Contacts in
// results — the contact router's read gate is the source of truth, but
// this surface is a list-of-suggestions so we filter at query time.

import { phoneSearchDigitRuns } from '@studymind/core/contact/phone-search'
import { z } from 'zod'

import { protectedProcedure, router } from '@/lib/trpc/builders'

const MAX_PER_TYPE = 10

const GlobalSearchInput = z.object({
  q: z.string().trim().min(1).max(120),
})

export interface SearchContactHit {
  id: string
  displayName: string
  email: string | null
  phoneE164: string | null
  kind: string
}

export interface SearchFamilyHit {
  id: string
  name: string
  state: string
  billingContactName: string | null
}

export const searchRouter = router({
  global: protectedProcedure
    .input(GlobalSearchInput)
    .query(async ({ ctx, input }) => {
      const q = input.q
      // A phone-shaped query ("07818 953024", "+44 7818-953024") is matched by
      // digit run so separators, the country code, and the trunk 0 are all
      // optional — a literal contains on the raw string can never match the
      // stored E.164 form (§29).
      const phoneRuns = phoneSearchDigitRuns(q)

      // Contacts: simple ILIKE search, ranked by exact-prefix > contains.
      // Restricted contacts are excluded from the suggestion surface; if a
      // DSL wants them they can navigate directly.
      const contactRows = await ctx.db.contact.findMany({
        where: {
          deletedAt: null,
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phoneE164: { contains: q, mode: 'insensitive' } },
            ...phoneRuns.map((run) => ({ phoneE164: { contains: run } })),
          ],
          safeguardingFlags: {
            none: { state: 'restricted_access' },
          },
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneE164: true,
          kind: true,
        },
        take: MAX_PER_TYPE,
        orderBy: [{ updatedAt: 'desc' }],
      })

      const contacts: SearchContactHit[] = contactRows.map((c) => ({
        id: c.id,
        displayName:
          [c.firstName, c.lastName].filter(Boolean).join(' ') ||
          c.email ||
          c.phoneE164 ||
          `Contact ${c.id.slice(-6)}`,
        email: c.email,
        phoneE164: c.phoneE164,
        kind: c.kind,
      }))

      // Families: match against name + billing contact name.
      const familyRows = await ctx.db.family.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            {
              billingContact: {
                OR: [
                  { firstName: { contains: q, mode: 'insensitive' } },
                  { lastName: { contains: q, mode: 'insensitive' } },
                ],
              },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          state: true,
          billingContact: {
            select: { firstName: true, lastName: true },
          },
        },
        take: MAX_PER_TYPE,
        orderBy: [{ updatedAt: 'desc' }],
      })

      const families: SearchFamilyHit[] = familyRows.map((f) => {
        const billingName = f.billingContact
          ? [f.billingContact.firstName, f.billingContact.lastName]
              .filter(Boolean)
              .join(' ') || null
          : null
        return {
          id: f.id,
          name: f.name ?? billingName ?? `Family ${f.id.slice(-6)}`,
          state: f.state,
          billingContactName: billingName,
        }
      })

      return { contacts, families }
    }),
})
