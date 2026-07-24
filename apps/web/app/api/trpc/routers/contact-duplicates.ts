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

const MANAGER_PLUS = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

// Merges per interactive drain call. Small so each HTTP request stays snappy;
// the page loops drainNow until the backlog is empty.
const DRAIN_CHUNK = 400

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

  // Run the automatic merge immediately (ADR 0047, widened 2026-07). The hourly
  // cron does the same thing unattended; this is the explicit Manager+ "do it
  // now" trigger. Fully automatic: it merges EVERY duplicate cluster — any
  // contacts sharing an email or a phone — into its oldest record with no
  // per-merge review. Single bounded pass; the page's drainNow loops for a big
  // backlog. Deliberately ignores CONTACTS_AUTO_MERGE=off — a human explicitly
  // asked for a merge here, so the kill-switch (which pauses only the automatic
  // paths) doesn't block them.
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

  // Fully-automatic backlog drain, run synchronously in the request so opening
  // /contacts/duplicates clears every duplicate with NO human step (ADR 0047).
  // This is the fix for self-hosted Inngest, where the hourly
  // `contacts/auto-merge-duplicates` cron often doesn't fire — so duplicates
  // used to pile up and the page (wrongly) asked for a manual merge. Each call
  // merges a bounded chunk and reports whether more work remains, so the page
  // loops until drained (mirrors the Slack-mentions tray `drainNow`). Respects
  // the one human control: CONTACTS_AUTO_MERGE=off pauses it and the page falls
  // back to fully-manual review.
  drainNow: auditedProcedure.input(z.object({}).optional()).mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!MANAGER_PLUS.has(user.role)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only Manager or above can merge contacts',
      })
    }
    const disabled = (process.env['CONTACTS_AUTO_MERGE'] ?? '').toLowerCase() === 'off'
    if (disabled) {
      await ctx.audit({
        action: 'contact.merged',
        target: { type: 'System', id: 'contacts/auto-merge-duplicates' },
        after: { disabled: true, merged: 0, skipped: 0, drain: true },
      })
      return { merged: 0, skipped: 0, done: true, disabled: true }
    }
    const result = await runAutoMergeDuplicates(ctx.db, {
      actorId: user.id,
      actorUserId: user.id,
      maxMerges: DRAIN_CHUNK,
    })
    await ctx.audit({
      action: 'contact.merged',
      target: { type: 'System', id: 'contacts/auto-merge-duplicates' },
      after: { ...result, drain: true },
    })
    // `done` when a full pass merged nothing: the backlog is drained, or only a
    // genuinely-unmergeable pair remains (a restricted-access DSL conflict,
    // §41.1) — the single case a human still resolves.
    return {
      merged: result.merged,
      skipped: result.skipped,
      done: result.merged === 0,
      disabled: false,
    }
  }),
})
