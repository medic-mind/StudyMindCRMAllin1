// Global "Call Summaries" entry point (the top-level nav section). Staff can
// submit a call summary for anyone — even someone not yet in the CRM — and a
// smart de-dup guard aligns it with an existing contact (name / phone / email,
// plus identifiers scanned out of the summary body) so an accidental duplicate
// is caught before a ghost contact is created. The actual send/hand-off then
// runs through the shared CallSummaryWizard against the resolved contact.
//
// Reads are open to all staff (everyone records calls); no money or
// safeguarding data is exposed. CLAUDE.md §3 (never auto-merge), §41.1.

import { z } from 'zod'

import { displayNameOf } from '@studymind/core/contact'
import {
  extractIdentifiersFromText,
  matchContactByCandidate,
  phoneVariants,
} from '@studymind/core/contact/match-candidate'

import { protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

const CandidateInput = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(254).optional(),
  /** As-typed; normalised to E.164 variants server-side. */
  phone: z.string().trim().max(40).optional(),
  /** The summary body — scanned for an email/phone the typist didn't field. */
  body: z.string().trim().max(8000).optional(),
})

export const callSummariesRouter = router({
  /**
   * De-dup guard: resolve typed name/email/phone (and identifiers found in the
   * body) to ONE existing contact, or surface candidates for the human to
   * pick. Never decides a merge itself.
   */
  findContactCandidates: protectedProcedure
    .input(CandidateInput)
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      // Identifiers the agent typed in a field win; fall back to scanning the
      // summary body ("spoke to Jane on 07700 900123").
      const fromText = input.body ? extractIdentifiersFromText(input.body) : { email: null, phone: null }
      const email = (input.email || fromText.email || '').trim().toLowerCase() || null
      const phone = (input.phone || fromText.phone || '').trim() || null
      const name = input.name?.trim().replace(/\s+/gu, ' ') || null

      const match = await matchContactByCandidate(ctx.db, { name, email, phone })

      // Gather candidates to show (email, phone variants, name) — capped.
      const ors: Array<Record<string, unknown>> = []
      if (email) ors.push({ email: { equals: email, mode: 'insensitive' } })
      if (phone) {
        const variants = phoneVariants(phone)
        if (variants.length > 0) ors.push({ phoneE164: { in: variants } })
        const digits = phone.replace(/[^\d]/gu, '')
        if (digits.length >= 9) ors.push({ phoneE164: { endsWith: digits.slice(-9) } })
      }
      if (name) {
        const tokens = name.split(' ')
        if (tokens.length >= 2) {
          ors.push({
            firstName: { equals: tokens[0]!, mode: 'insensitive' },
            lastName: { equals: tokens.slice(1).join(' '), mode: 'insensitive' },
          })
        }
        // First-name-only contributes to the "possible matches" list (display
        // only — it never auto-resolves).
        ors.push({
          OR: [
            { firstName: { contains: name, mode: 'insensitive' } },
            { lastName: { contains: name, mode: 'insensitive' } },
          ],
        })
      }

      const candidates =
        ors.length > 0
          ? await ctx.db.contact.findMany({
              where: { deletedAt: null, OR: ors },
              orderBy: { updatedAt: 'desc' },
              take: 8,
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phoneE164: true,
                kind: true,
              },
            })
          : []

      return {
        match: match.contactId ? { contactId: match.contactId, via: match.via } : null,
        ambiguous: match.reason === 'ambiguous',
        resolvedEmail: email,
        resolvedPhone: phone,
        candidates: candidates.map((c) => ({
          id: c.id,
          name: displayNameOf(c),
          email: c.email,
          phoneE164: c.phoneE164,
          kind: c.kind,
        })),
      }
    }),

  /** Recent call summaries across the CRM — the queue on /call-summaries. */
  recent: protectedProcedure
    .input(
      z
        .object({
          filter: z.enum(['all', 'mine']).default('all'),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .default({ filter: 'all', limit: 30 }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const rows = await ctx.db.interaction.findMany({
        where: {
          type: 'call_summary',
          deletedAt: null,
          ...(input.filter === 'mine' ? { createdById: user.id } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: input.limit,
        select: {
          id: true,
          occurredAt: true,
          summary: true,
          payload: true,
          createdById: true,
          contact: {
            select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
          },
        },
      })

      const authorIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))]
      const authors =
        authorIds.length > 0
          ? await ctx.db.user.findMany({
              where: { id: { in: authorIds } },
              select: { id: true, name: true, email: true },
            })
          : []
      const authorById = new Map(authors.map((a) => [a.id, a.name ?? a.email]))

      return rows.map((r) => {
        const payload = (r.payload ?? {}) as { outcome?: string | null }
        return {
          id: r.id,
          occurredAt: r.occurredAt,
          summary: r.summary,
          outcome: typeof payload.outcome === 'string' ? payload.outcome : null,
          authorName: r.createdById ? (authorById.get(r.createdById) ?? null) : null,
          contact: r.contact
            ? {
                id: r.contact.id,
                name: displayNameOf(r.contact),
                email: r.contact.email,
                phoneE164: r.contact.phoneE164,
              }
            : null,
        }
      })
    }),
})
