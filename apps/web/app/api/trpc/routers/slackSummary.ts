// Unassigned Slack-mentions tray (ADR 0034). When the AI finds a customer
// reference in a watched Slack channel but can't confidently match it to a
// Contact (or it's a name-only mention), the message is parked in
// `UnassignedSummary`. This router powers the triage UI: list the parked
// mentions, then either ASSIGN one to a customer (which writes the durable
// `slack_summary` Interaction on that contact) or DISMISS it. Nothing is lost
// and we never auto-create / auto-match (CLAUDE.md §12, §3).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const TRIAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['ceo', 'senior_manager', 'manager'])

function assertCanTriage(role: UserRole): void {
  if (!TRIAGE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Sales Executive or above can triage' })
  }
}

interface ParsedView {
  summary: string | null
  category: string | null
  sentiment: string | null
  suggestedNextAction: string | null
  candidateName: string | null
  candidateEmail: string | null
  candidatePhone: string | null
}

function readParsed(raw: unknown): ParsedView {
  const o = (raw ?? {}) as Record<string, unknown>
  const cand = (o['candidateContactIdentifier'] ?? {}) as Record<string, unknown>
  const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
  return {
    summary: s(o['summary']),
    category: s(o['category']),
    sentiment: s(o['sentiment']),
    suggestedNextAction: s(o['suggestedNextAction']),
    candidateName: s(cand['name']),
    candidateEmail: s(cand['email']),
    candidatePhone: s(cand['phone']),
  }
}

export const slackSummaryRouter = router({
  unassigned: router({
    /** Count of open (unresolved) parked mentions — drives the nav badge. */
    count: protectedProcedure.query(async ({ ctx }) => {
      return ctx.db.unassignedSummary.count({ where: { resolvedAt: null } })
    }),

    /**
     * Why mentions might be stuck here. The single biggest cause of "confidence
     * 0% — no identifier found" is no AI provider key: name-only mentions can't
     * be extracted, so only ones carrying an email/phone (or a phone/email in
     * their thread root) auto-link. Surfacing this lets an admin fix the real
     * gap instead of triaging by hand forever.
     */
    diagnostics: protectedProcedure.query(() => ({
      aiConfigured: Boolean(
        process.env['GEMINI_API_KEY'] ??
        process.env['GOOGLE_API_KEY'] ??
        process.env['OPENAI_API_KEY'] ??
        process.env['ANTHROPIC_API_KEY'],
      ),
    })),

    /** Latest open parked mentions for the triage tray. */
    list: protectedProcedure
      .input(
        z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 }),
      )
      .query(async ({ ctx, input }) => {
        const rows = await ctx.db.unassignedSummary.findMany({
          where: { resolvedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
        })
        return rows.map((r) => {
          const occurredAt = new Date(Number(r.slackTs.split('.')[0] ?? 0) * 1000)
          return {
            id: r.id,
            slackTs: r.slackTs,
            channelId: r.channelId,
            confidence: r.confidence,
            messageText: r.messageText,
            senderName: r.senderName,
            createdAt: r.createdAt,
            occurredAt,
            ...readParsed(r.parsed),
          }
        })
      }),

    /**
     * Assign a parked mention to a customer Contact OR a B2B account (school /
     * partnership) — writes the durable `slack_summary` record on whichever was
     * chosen. Exactly one of `contactId` / `businessAccountId` must be given.
     * When a contact is chosen we also stamp its primary account, so the mention
     * shows on both (§12, parity with auto-import).
     */
    assign: auditedProcedure
      .input(
        z
          .object({
            id: z.string(),
            contactId: z.string().optional(),
            businessAccountId: z.string().optional(),
          })
          .refine((v) => Boolean(v.contactId) !== Boolean(v.businessAccountId), {
            message: 'Provide exactly one of contactId or businessAccountId',
          }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanTriage(user.role)

        const row = await ctx.db.unassignedSummary.findFirst({
          where: { id: input.id, resolvedAt: null },
        })
        if (!row)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Mention not found or already triaged',
          })

        // Resolve the target: a Contact (plus its primary school) or an account.
        let contactId: string | null = null
        let businessAccountId: string | null = null
        if (input.contactId) {
          const contact = await ctx.db.contact.findFirst({
            where: { id: input.contactId, deletedAt: null },
            select: { id: true },
          })
          if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
          contactId = contact.id
          const link = await ctx.db.businessAccountContact.findFirst({
            where: { contactId: contact.id },
            select: { accountId: true },
            orderBy: { accountId: 'asc' },
          })
          businessAccountId = link?.accountId ?? null
        } else {
          const account = await ctx.db.businessAccount.findFirst({
            where: { id: input.businessAccountId, archivedAt: null },
            select: { id: true },
          })
          if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
          businessAccountId = account.id
        }

        const parsed = readParsed(row.parsed)
        const occurredAt = new Date(Number(row.slackTs.split('.')[0] ?? 0) * 1000)
        const interactionId = createId()

        await ctx.db.$transaction([
          ctx.db.interaction.create({
            data: {
              id: interactionId,
              type: 'slack_summary',
              ...(contactId ? { contactId } : {}),
              ...(businessAccountId ? { businessAccountId } : {}),
              occurredAt,
              summary: (parsed.summary ?? row.messageText ?? 'Slack mention').slice(0, 280),
              payload: {
                event: 'slack.message_summarised',
                source: 'manual_assign',
                slackTs: row.slackTs,
                channelId: row.channelId,
                channelName: null,
                messageText: row.messageText,
                senderName: row.senderName,
                category: parsed.category,
                sentiment: parsed.sentiment,
                suggestedNextAction: parsed.suggestedNextAction,
                confidence: row.confidence,
                linkedTo: contactId ? 'contact' : 'account',
                assignedById: user.id,
              },
            },
          }),
          ctx.db.unassignedSummary.update({
            where: { id: row.id },
            data: { resolvedAt: new Date(), resolvedById: user.id },
          }),
        ])

        await ctx.audit({
          action: 'slack_summary.assigned',
          target: contactId
            ? { type: 'Contact', id: contactId }
            : { type: 'BusinessAccount', id: businessAccountId! },
          after: { interactionId, unassignedSummaryId: row.id, channelId: row.channelId },
        })
        return { interactionId }
      }),

    /**
     * Re-run Slack matching immediately (the cron also does this every 15 min).
     * Fires the on-demand Inngest twin which (1) re-runs the resolver over every
     * parked row and auto-links the unambiguous ones, and (2) retro-stamps
     * historic contact-linked mentions onto their school. Returns once enqueued;
     * results land asynchronously. Manager+ — a workspace-wide reprocess.
     */
    relinkNow: auditedProcedure.mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!MANAGE_ROLES.has(user.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only Manager or above can re-run Slack matching',
        })
      }
      const { inngest } = await import('@studymind/jobs')
      await inngest.send({
        name: 'slack/relink-now.requested',
        data: { actorId: user.id },
      })
      await ctx.audit({
        action: 'slack_summary.relink_requested',
        target: { type: 'System', id: 'slack-relink' },
        after: { requestedBy: user.id },
      })
      return { ok: true as const }
    }),

    /**
     * Drain the parked tray SYNCHRONOUSLY, in the request — no Inngest. This is
     * the reliable fallback for a self-hosted Inngest where the
     * `slack/relink-unassigned` cron doesn't fire, so the old backlog never
     * clears. Each call links/auto-onboards or (full-auto) dismisses a bounded
     * chunk and returns how many remain, so the tray can auto-repeat until zero
     * with no button. DB-only (no rate-limited Slack thread fetches) to stay
     * fast. Sales Executive+ (same as triage), since the tray auto-fires it.
     */
    drainNow: auditedProcedure.mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      assertCanTriage(user.role)
      const { relinkParkedRowsBatch } = await import('@studymind/integration-slack/relink')
      // Bounded per call (≈300 rows) so the request never times out; the tray
      // loops until `remaining` is 0.
      const MAX_BATCHES = 3
      let afterId: string | null = null
      const totals = { scanned: 0, linked: 0, dismissed: 0 }
      for (let i = 0; i < MAX_BATCHES; i += 1) {
        const batch = await relinkParkedRowsBatch(user.id, afterId, { threadFetches: 0 })
        totals.scanned += batch.scanned
        totals.linked += batch.linked
        totals.dismissed += batch.dismissed
        if (batch.done) break
        afterId = batch.lastId
      }
      const remaining = await ctx.db.unassignedSummary.count({ where: { resolvedAt: null } })
      await ctx.audit({
        action: 'slack_summary.relink_requested',
        target: { type: 'System', id: 'slack-drain-sync' },
        after: { ...totals, remaining, sync: true, by: user.id },
      })
      return { ...totals, remaining }
    }),

    /**
     * Pull recent messages from EVERY channel the bot is in, right now (the
     * slack/sync-messages cron also runs every 15 min). This is the fix for
     * "messages aren't being pulled": it doesn't rely on the Events webhook —
     * it fetches via the bot token across all member channels. `lookbackHours`
     * lets a manual sync reach back further. Manager+.
     */
    syncNow: auditedProcedure
      .input(z.object({ lookbackHours: z.number().int().min(1).max(168).optional() }).default({}))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!MANAGE_ROLES.has(user.role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only Manager or above can sync from Slack',
          })
        }
        const configured = Boolean(process.env['SLACK_BOT_TOKEN'])
        if (configured) {
          const { inngest } = await import('@studymind/jobs')
          await inngest.send({
            name: 'slack/sync-now.requested',
            data: {
              actorId: user.id,
              ...(input.lookbackHours ? { lookbackMinutes: input.lookbackHours * 60 } : {}),
            },
          })
        }
        await ctx.audit({
          action: 'slack_summary.sync_requested',
          target: { type: 'System', id: 'slack-sync' },
          after: { requestedBy: user.id, configured },
        })
        return { ok: true as const, configured }
      }),

    /** Dismiss a parked mention — no record written, just cleared from the tray. */
    dismiss: auditedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanTriage(user.role)
        const row = await ctx.db.unassignedSummary.findFirst({
          where: { id: input.id, resolvedAt: null },
          select: { id: true, channelId: true },
        })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
        await ctx.db.unassignedSummary.update({
          where: { id: row.id },
          data: { resolvedAt: new Date(), resolvedById: user.id },
        })
        await ctx.audit({
          action: 'slack_summary.dismissed',
          target: { type: 'UnassignedSummary', id: row.id },
          after: { channelId: row.channelId },
        })
        return { ok: true }
      }),

    /**
     * Bulk-dismiss parked mentions in one action — the human complement to the
     * cron's auto-dismiss, so an agent can clear a screen of noise/dead rows at
     * once instead of X-ing them one by one. Only clears rows still open; caps
     * the batch so it stays a single fast transaction. One audit row per cleared
     * mention (§20/§27) so the bulk action stays fully accountable.
     */
    bulkDismiss: auditedProcedure
      .input(z.object({ ids: z.array(z.string()).min(1).max(200) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanTriage(user.role)
        const rows = await ctx.db.unassignedSummary.findMany({
          where: { id: { in: input.ids }, resolvedAt: null },
          select: { id: true, channelId: true },
        })
        if (rows.length === 0) return { dismissed: 0 }
        await ctx.db.unassignedSummary.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, resolvedAt: null },
          data: { resolvedAt: new Date(), resolvedById: user.id },
        })
        for (const row of rows) {
          await ctx.audit({
            action: 'slack_summary.dismissed',
            target: { type: 'UnassignedSummary', id: row.id },
            after: { channelId: row.channelId, bulk: true },
          })
        }
        return { dismissed: rows.length }
      }),
  }),
})
