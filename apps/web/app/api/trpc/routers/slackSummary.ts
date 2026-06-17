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
])

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

    /** Assign a parked mention to a contact — writes the durable record. */
    assign: auditedProcedure
      .input(z.object({ id: z.string(), contactId: z.string() }))
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

        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true },
        })
        if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })

        const parsed = readParsed(row.parsed)
        const occurredAt = new Date(Number(row.slackTs.split('.')[0] ?? 0) * 1000)
        const interactionId = createId()

        await ctx.db.$transaction([
          ctx.db.interaction.create({
            data: {
              id: interactionId,
              type: 'slack_summary',
              contactId: contact.id,
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
          target: { type: 'Contact', id: contact.id },
          after: { interactionId, unassignedSummaryId: row.id, channelId: row.channelId },
        })
        return { interactionId }
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
  }),
})
