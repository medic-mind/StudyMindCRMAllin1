// Contact-field suggestion review queue (ADR 0020 Phase 6c).
// CLAUDE.md §3 — every accept is a deliberate, audited human action; no
// silent merge.
//
// list   — pending suggestions for the queue page. Staff-gated.
// accept — apply the proposed value to the Contact and mark the row
//          accepted. Audited. Manager+ only (it's a Contact write, and
//          accepts may touch email/phone — money + GDPR-sensitive fields).
// reject — mark the row rejected. Audited. Manager+.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const READ_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const WRITE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const FIELD_ENUM = z.enum(['firstName', 'lastName', 'email', 'phoneE164'])

export const contactSuggestionsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        status: z
          .enum(['pending', 'accepted', 'rejected', 'superseded'])
          .default('pending'),
        contactId: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!READ_ROLES.has(user.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Suggestion review is staff-only.',
        })
      }
      const rows = await ctx.db.contactFieldSuggestion.findMany({
        where: {
          status: input.status,
          ...(input.contactId ? { contactId: input.contactId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        select: {
          id: true,
          contactId: true,
          source: true,
          sourceEventId: true,
          field: true,
          proposedValue: true,
          currentValue: true,
          status: true,
          createdAt: true,
          reviewedAt: true,
          contact: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      })
      return rows.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        source: r.source,
        sourceEventId: r.sourceEventId,
        field: r.field,
        proposedValue: r.proposedValue,
        currentValue: r.currentValue,
        status: r.status,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt,
        contactName: r.contact
          ? [r.contact.firstName, r.contact.lastName]
              .filter((x): x is string => !!x)
              .join(' ') || r.contact.email || null
          : null,
      }))
    }),

  accept: auditedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!WRITE_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const row = await ctx.db.contactFieldSuggestion.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          contactId: true,
          field: true,
          proposedValue: true,
          currentValue: true,
          status: true,
        },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      if (row.status !== 'pending') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Only pending suggestions can be accepted.',
        })
      }
      const parsedField = FIELD_ENUM.parse(row.field)
      // Apply the proposed value to the Contact + mark the suggestion
      // accepted in a single transaction so the Contact row and the
      // suggestion row are consistent.
      const before = await ctx.db.contact.findUnique({
        where: { id: row.contactId },
        select: { [parsedField]: true },
      })
      const beforeValue =
        before === null ? null : ((before as Record<string, unknown>)[parsedField] ?? null)
      await ctx.db.$transaction([
        ctx.db.contact.update({
          where: { id: row.contactId },
          data: { [parsedField]: row.proposedValue },
        }),
        ctx.db.contactFieldSuggestion.update({
          where: { id: row.id },
          data: {
            status: 'accepted',
            reviewedAt: new Date(),
            reviewedById: user.id,
          },
        }),
      ])
      await ctx.audit({
        action: 'contact.suggestion_accepted',
        target: { type: 'Contact', id: row.contactId },
        before: { [parsedField]: beforeValue },
        after: {
          [parsedField]: row.proposedValue,
          suggestionId: row.id,
        },
      })
      return { ok: true as const }
    }),

  reject: auditedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!WRITE_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const row = await ctx.db.contactFieldSuggestion.findUnique({
        where: { id: input.id },
        select: { id: true, contactId: true, status: true, field: true },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      if (row.status !== 'pending') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Only pending suggestions can be rejected.',
        })
      }
      await ctx.db.contactFieldSuggestion.update({
        where: { id: row.id },
        data: {
          status: 'rejected',
          reviewedAt: new Date(),
          reviewedById: user.id,
          rejectionReason: input.reason ?? null,
        },
      })
      await ctx.audit({
        action: 'contact.suggestion_rejected',
        target: { type: 'Contact', id: row.contactId },
        after: { suggestionId: row.id, field: row.field, reason: input.reason ?? null },
      })
      return { ok: true as const }
    }),
})
