// Family router. See CLAUDE.md Sections 6.1, 27, 41.1.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  FamilyCreateInput,
  FamilyLinkContactInput,
  FamilySetBillingContactInput,
  assertBillingContactNotStudent,
} from '@studymind/core/family'

import { auditedProcedure, protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

function newId(): string {
  return createId()
}

export const familyRouter = router({
  create: auditedProcedure
    .input(FamilyCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const id = newId()
      const family = await ctx.db.family.create({
        data: {
          id,
          name: input.name ?? null,
          billingParty: input.billingParty,
          billingContactId: input.billingContactId ?? null,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'family.created',
        target: { type: 'Family', id: family.id },
        before: null,
        after: family,
      })
      return { id: family.id }
    }),

  linkContact: auditedProcedure
    .input(FamilyLinkContactInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // Enforce invariant: if linking as student, ensure not the billing contact.
      const family = await ctx.db.family.findFirst({
        where: { id: input.familyId, deletedAt: null },
        include: {
          members: { select: { contactId: true, role: true } },
        },
      })
      if (!family) throw new TRPCError({ code: 'NOT_FOUND' })

      const proposed = [
        ...family.members.map((m) => ({
          contactId: m.contactId,
          role: m.role as 'billing' | 'student' | 'guardian' | 'other',
        })),
        { contactId: input.contactId, role: input.role },
      ]
      try {
        assertBillingContactNotStudent(family.billingContactId, proposed)
      } catch (err) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: err instanceof Error ? err.message : 'invariant violation',
        })
      }

      const link = await ctx.db.familyMember.upsert({
        where: {
          familyId_contactId: { familyId: input.familyId, contactId: input.contactId },
        },
        create: {
          id: newId(),
          familyId: input.familyId,
          contactId: input.contactId,
          role: input.role,
          createdById: user.id,
          updatedById: user.id,
        },
        update: {
          role: input.role,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'family.contact_linked',
        target: { type: 'Family', id: input.familyId },
        before: null,
        after: link,
      })
      return { id: link.id }
    }),

  setBillingContact: auditedProcedure
    .input(FamilySetBillingContactInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const family = await ctx.db.family.findFirst({
        where: { id: input.familyId, deletedAt: null },
        include: { members: { select: { contactId: true, role: true } } },
      })
      if (!family) throw new TRPCError({ code: 'NOT_FOUND' })

      try {
        assertBillingContactNotStudent(
          input.newBillingContactId,
          family.members.map((m) => ({
            contactId: m.contactId,
            role: m.role as 'billing' | 'student' | 'guardian' | 'other',
          })),
        )
      } catch (err) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: err instanceof Error ? err.message : 'invariant violation',
        })
      }

      const previousId = family.billingContactId

      const updated = await ctx.db.$transaction(async (tx) => {
        const next = await tx.family.update({
          where: { id: input.familyId },
          data: {
            billingContactId: input.newBillingContactId,
            updatedById: user.id,
          },
        })
        await tx.interaction.create({
          data: {
            id: newId(),
            type: 'family_billing_contact_changed',
            familyId: input.familyId,
            occurredAt: input.effectiveDate ?? new Date(),
            summary: `Billing contact changed: ${input.reason}`,
            payload: {
              previousContactId: previousId,
              newContactId: input.newBillingContactId,
              reason: input.reason,
              effectiveDate: input.effectiveDate?.toISOString() ?? null,
            },
            createdById: user.id,
            updatedById: user.id,
          },
        })
        return next
      })

      await ctx.audit({
        action: 'family.billing_contact_changed',
        target: { type: 'Family', id: input.familyId },
        before: { billingContactId: previousId },
        after: { billingContactId: updated.billingContactId, reason: input.reason },
      })
      return { id: updated.id }
    }),

  get: protectedProcedure
    // Read endpoint. Reads of minor data carry an audit obligation per §20; this
    // is enforced at the field level in a follow-up PR (encrypted notes path).
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const f = await ctx.db.family.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          members: {
            include: { contact: { select: { id: true, firstName: true, lastName: true, isMinor: true } } },
          },
        },
      })
      if (!f) throw new TRPCError({ code: 'NOT_FOUND' })
      return f
    }),
})
