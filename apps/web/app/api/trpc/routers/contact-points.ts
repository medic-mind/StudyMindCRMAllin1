// `contact.points.*` — additional points of contact (ContactChannel): extra
// emails, phone numbers and other handles beyond the primary
// Contact.email / Contact.phoneE164 (which stay the matching source of truth).
// Mounted under `contact` in root.ts. Writes are audited against the Contact
// (§20/§27); list is any authenticated staff (mirrors contact.documents).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ContactPointCreateInput,
  ContactPointRemoveInput,
  ContactPointUpdateInput,
  normaliseContactPointValue,
} from '@studymind/core/contact/points'

import { auditedProcedure, protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

export const contactPointsRouter = router({
  list: protectedProcedure
    .input(z.object({ contactId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return ctx.db.contactChannel.findMany({
        where: { contactId: input.contactId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, kind: true, value: true, label: true, sortOrder: true },
      })
    }),

  add: auditedProcedure.input(ContactPointCreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    const contact = await ctx.db.contact.findFirst({
      where: { id: input.contactId, deletedAt: null },
      select: { id: true },
    })
    if (!contact) throw new TRPCError({ code: 'NOT_FOUND' })

    const value = normaliseContactPointValue(input.kind, input.value)
    const last = await ctx.db.contactChannel.findFirst({
      where: { contactId: input.contactId, deletedAt: null },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    })
    const row = await ctx.db.contactChannel.create({
      data: {
        id: createId(),
        contactId: input.contactId,
        kind: input.kind,
        value,
        label: input.label?.trim() ? input.label.trim() : null,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        createdById: user.id,
        updatedById: user.id,
      },
      select: { id: true, kind: true, value: true, label: true, sortOrder: true },
    })
    await ctx.audit({
      action: 'contact.point_added',
      target: { type: 'Contact', id: input.contactId },
      after: { pointId: row.id, kind: row.kind, value: row.value, label: row.label },
    })
    return row
  }),

  update: auditedProcedure.input(ContactPointUpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    const before = await ctx.db.contactChannel.findFirst({
      where: { id: input.id, deletedAt: null },
      select: { id: true, contactId: true, kind: true, value: true, label: true },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })

    const value =
      input.value !== undefined ? normaliseContactPointValue(before.kind, input.value) : undefined
    if (before.kind === 'email' && value !== undefined && !EMAIL_RE.test(value)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter a valid email address' })
    }
    const after = await ctx.db.contactChannel.update({
      where: { id: input.id },
      data: {
        ...(value !== undefined ? { value } : {}),
        ...(input.label !== undefined
          ? { label: input.label?.trim() ? input.label.trim() : null }
          : {}),
        updatedById: user.id,
      },
      select: { id: true, kind: true, value: true, label: true, sortOrder: true },
    })
    await ctx.audit({
      action: 'contact.point_updated',
      target: { type: 'Contact', id: before.contactId },
      before: { pointId: before.id, value: before.value, label: before.label },
      after: { pointId: after.id, value: after.value, label: after.label },
    })
    return after
  }),

  remove: auditedProcedure.input(ContactPointRemoveInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    const before = await ctx.db.contactChannel.findFirst({
      where: { id: input.id, deletedAt: null },
      select: { id: true, contactId: true, kind: true, value: true, label: true },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    await ctx.db.contactChannel.update({
      where: { id: input.id },
      data: { deletedAt: new Date(), updatedById: user.id },
    })
    await ctx.audit({
      action: 'contact.point_removed',
      target: { type: 'Contact', id: before.contactId },
      before: { pointId: before.id, kind: before.kind, value: before.value, label: before.label },
    })
    return { id: input.id }
  }),
})
