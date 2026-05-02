// Contact router. See CLAUDE.md Sections 27, 20.
// All mutations are audited (auditedProcedure runtime-checks ctx.audit was called).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ContactCreateInput,
  ContactSummary,
  ContactUpdateInput,
  isMinorByDob,
} from '@studymind/core/contact'

import { toContactDetail, toContactSummary } from '@/lib/view-models/contact'

import { auditedProcedure, protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

const ListInput = z.object({
  cursor: z
    .object({
      id: z.string(),
      createdAt: z.date(),
    })
    .nullish(),
  limit: z.number().min(1).max(100).default(25),
  q: z.string().trim().min(1).max(120).optional(),
})

function newId(): string {
  return createId()
}

export const contactRouter = router({
  list: protectedProcedure
    .input(ListInput)
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.contact.findMany({
        where: {
          deletedAt: null,
          ...(input.q
            ? {
                OR: [
                  { firstName: { contains: input.q, mode: 'insensitive' } },
                  { lastName: { contains: input.q, mode: 'insensitive' } },
                  { email: { contains: input.q, mode: 'insensitive' } },
                  { phoneE164: { contains: input.q } },
                ],
              }
            : {}),
          ...(input.cursor
            ? {
                OR: [
                  { createdAt: { lt: input.cursor.createdAt } },
                  {
                    AND: [
                      { createdAt: input.cursor.createdAt },
                      { id: { lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        include: {
          familyMembers: {
            take: 1,
            include: { family: { select: { id: true, name: true } } },
          },
          interactions: {
            where: { deletedAt: null },
            orderBy: { occurredAt: 'desc' },
            take: 1,
            select: { occurredAt: true },
          },
        },
      })

      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const items: ContactSummary[] = sliced.map(toContactSummary)
      const last = sliced[sliced.length - 1]
      const nextCursor =
        hasMore && last ? { id: last.id, createdAt: last.createdAt } : null
      return { items, nextCursor }
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.contact.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          familyMembers: {
            take: 1,
            include: { family: { select: { id: true, name: true } } },
          },
          safeguardingFlags: { where: { deletedAt: null }, select: { state: true } },
        },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return toContactDetail(row)
    }),

  create: auditedProcedure
    .input(ContactCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const id = newId()
      const minor = isMinorByDob(input.dateOfBirth)
      const created = await ctx.db.contact.create({
        data: {
          id,
          kind: input.kind,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          email: input.email ?? null,
          phoneE164: input.phoneE164 ?? null,
          dateOfBirth: input.dateOfBirth ?? null,
          isMinor: minor,
          notes: input.notes ?? null,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'contact.created',
        target: { type: 'Contact', id: created.id },
        before: null,
        after: created,
      })
      return { id: created.id }
    }),

  update: auditedProcedure
    .input(ContactUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const before = await ctx.db.contact.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })

      const after = await ctx.db.contact.update({
        where: { id: input.id },
        data: {
          firstName: input.firstName ?? undefined,
          lastName: input.lastName ?? undefined,
          email: input.email ?? undefined,
          phoneE164: input.phoneE164 ?? undefined,
          dateOfBirth: input.dateOfBirth ?? undefined,
          notes: input.notes ?? undefined,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'contact.updated',
        target: { type: 'Contact', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),
})
