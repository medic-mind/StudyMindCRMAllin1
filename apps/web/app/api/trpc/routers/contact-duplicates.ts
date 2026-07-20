// Duplicate-contact finder for the cleanup page (§3 — surfaces candidates;
// the human confirms each merge, which runs through contact.bulkMerge). Kept
// in its own small router because the main contact router is already large
// enough that adding a procedure with a rich output degrades tRPC's client
// type inference.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { clusterDuplicates } from '@studymind/core/contact'

import { runAutoMergeDuplicates } from '@/lib/services/auto-merge-duplicates'
import { auditedProcedure, protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

const MANAGER_PLUS = new Set(['ceo', 'senior_manager', 'manager'])

export const contactDuplicatesRouter = router({
  find: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!MANAGER_PLUS.has(user.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only Manager or above can review duplicate contacts',
        })
      }
      // Oldest-first so the first member of each cluster is the natural
      // survivor; bounded scan over contacts that carry a matchable key.
      const rows = await ctx.db.contact.findMany({
        where: {
          deletedAt: null,
          OR: [{ email: { not: null } }, { phoneE164: { not: null } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 20000,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneE164: true,
          kind: true,
          createdAt: true,
          referralSource: true,
        },
      })
      const byId = new Map(rows.map((r) => [r.id, r]))
      const clusters = clusterDuplicates(
        rows.map((r) => ({ id: r.id, email: r.email, phoneE164: r.phoneE164 })),
      )
      const page = clusters.slice(0, input.limit).map((ids) => ({
        survivorId: ids[0]!,
        members: ids.map((id) => {
          const c = byId.get(id)!
          const name =
            [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
            c.email ||
            c.phoneE164 ||
            'Unnamed'
          return {
            id: c.id,
            name,
            email: c.email,
            phoneE164: c.phoneE164,
            kind: c.kind as string,
            createdAt: c.createdAt,
            referralSource: c.referralSource,
          }
        }),
      }))
      return {
        clusters: page,
        totalClusters: clusters.length,
        duplicateContacts: clusters.reduce((n, c) => n + c.length, 0),
        scanned: rows.length,
        capped: rows.length >= 20000,
      }
    }),

  // Run the confident auto-merge immediately (ADR 0047). The hourly cron does
  // the same thing unattended; this is the Manager+ "do it now" button. Only
  // merges contacts that are confidently the same person (shared email, or
  // phone + matching name) — ambiguous ones stay on this page for manual merge.
  autoMergeNow: auditedProcedure.input(z.object({}).optional()).mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!MANAGER_PLUS.has(user.role)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only Manager or above can merge contacts',
      })
    }
    const result = await runAutoMergeDuplicates(ctx.db, {
      actorId: user.id,
      actorUserId: user.id,
    })
    await ctx.audit({
      action: 'contact.merged',
      target: { type: 'System', id: 'contacts/auto-merge-duplicates' },
      after: { ...result, manual: true },
    })
    return result
  }),
})
