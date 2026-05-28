// Contact router. See CLAUDE.md Sections 27, 20.
// All mutations are audited (auditedProcedure runtime-checks ctx.audit was called).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ContactCreateInput,
  ContactLinkRelation,
  ContactSummary,
  ContactUpdateInput,
  displayNameOf,
  INVERSE_RELATION,
  isMinorByDob,
} from '@studymind/core/contact'

import { mergeContacts } from '@/lib/services/contact-merge'
import { findMergeCandidates } from '@/lib/services/merge-suggestions'
import { toContactDetail, toContactSummary } from '@/lib/view-models/contact'

import {
  auditedProcedure,
  enforceRestrictedAccess,
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

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
    .input(z.object({ id: z.string(), purpose: z.string().min(1).optional() }))
    .query(async ({ ctx, input }) => {
      await enforceRestrictedAccess(ctx, input.id, input.purpose ?? '')
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
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          postcode: input.postcode ?? null,
          country: input.country ?? null,
          schoolName: input.schoolName ?? null,
          yearGroup: input.yearGroup ?? null,
          sendStatus: input.sendStatus ?? null,
          jobTitle: input.jobTitle ?? null,
          pronouns: input.pronouns ?? null,
          mailchimpEmail: input.mailchimpEmail ?? null,
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

      // Update semantics: undefined → don't touch, null → clear, value → set.
      // Zod nullish() preserves the distinction.
      function pass<T>(v: T | null | undefined): T | null | undefined {
        return v
      }
      const after = await ctx.db.contact.update({
        where: { id: input.id },
        data: {
          firstName: pass(input.firstName),
          lastName: pass(input.lastName),
          email: pass(input.email),
          phoneE164: pass(input.phoneE164),
          dateOfBirth: pass(input.dateOfBirth),
          notes: pass(input.notes),
          addressLine1: pass(input.addressLine1),
          addressLine2: pass(input.addressLine2),
          city: pass(input.city),
          postcode: pass(input.postcode),
          country: pass(input.country),
          schoolName: pass(input.schoolName),
          yearGroup: pass(input.yearGroup),
          sendStatus: pass(input.sendStatus),
          jobTitle: pass(input.jobTitle),
          pronouns: pass(input.pronouns),
          mailchimpEmail: pass(input.mailchimpEmail),
          // Refresh isMinor from DOB whenever DOB is sent in this update.
          ...(input.dateOfBirth !== undefined
            ? { isMinor: isMinorByDob(input.dateOfBirth ?? null) }
            : {}),
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

  // CLAUDE.md §18, §20.1 — listing AI-derived merge suggestions is a read.
  // Any agent role can request suggestions; only admin/ops_manager can
  // perform the merge itself (`merge` mutation below).
  mergeSuggestions: router({
    list: protectedProcedure
      .input(z.object({ contactId: z.string() }))
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        // Read of AI merge candidates: any role above virtual_assistant
        // (ADR 0014). VAs can read contacts but should not see merge
        // suggestions — that's an operational decision, not a read.
        if (!['ceo', 'senior_manager', 'manager', 'sales_executive'].includes(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        return findMergeCandidates(ctx.db, input.contactId)
      }),
  }),

  // CLAUDE.md §20.1 — `family.merge` is admin/ops_manager only.
  merge: router({
    confirm: auditedProcedure
      .input(z.object({ survivorId: z.string(), loserId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        // family.merge restricted to ceo, senior_manager, manager (ADR 0014).
        if (!['ceo', 'senior_manager', 'manager'].includes(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        const result = await mergeContacts(ctx.db, {
          survivorId: input.survivorId,
          loserId: input.loserId,
          actorUserId: user.id,
        })
        await ctx.audit({
          action: 'contact.merged',
          target: { type: 'Contact', id: result.survivorId },
          after: result,
        })
        return result
      }),
  }),

  // Free-form relationships between contacts (parent ↔ student, sibling,
  // caseworker, tutor, etc). The reciprocal link is created in the same
  // transaction so the "linked contacts" list reads consistently from
  // either side.
  links: router({
    list: protectedProcedure
      .input(z.object({ contactId: z.string() }))
      .query(async ({ ctx, input }) => {
        const rows = await ctx.db.contactLink.findMany({
          where: { fromContactId: input.contactId },
          orderBy: { createdAt: 'desc' },
          include: {
            toContact: {
              select: {
                id: true,
                kind: true,
                firstName: true,
                lastName: true,
                email: true,
                phoneE164: true,
              },
            },
          },
        })
        return rows.map((r) => ({
          id: r.id,
          relation: r.relation,
          notes: r.notes,
          createdAt: r.createdAt,
          contact: {
            id: r.toContact.id,
            kind: r.toContact.kind,
            displayName: displayNameOf(r.toContact),
            email: r.toContact.email,
            phoneE164: r.toContact.phoneE164,
          },
        }))
      }),

    add: auditedProcedure
      .input(
        z.object({
          fromContactId: z.string(),
          toContactId: z.string(),
          relation: ContactLinkRelation,
          notes: z.string().trim().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (input.fromContactId === input.toContactId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'A contact cannot be linked to itself.',
          })
        }
        // Create forward + reciprocal in one transaction; ignore unique-key
        // conflicts so re-adding the same relation is a no-op.
        const result = await ctx.db.$transaction(async (tx) => {
          const forward = await tx.contactLink.upsert({
            where: {
              fromContactId_toContactId_relation: {
                fromContactId: input.fromContactId,
                toContactId: input.toContactId,
                relation: input.relation,
              },
            },
            create: {
              id: createId(),
              fromContactId: input.fromContactId,
              toContactId: input.toContactId,
              relation: input.relation,
              notes: input.notes ?? null,
              createdById: user.id,
            },
            update: { notes: input.notes ?? null },
          })
          const inverseRel = INVERSE_RELATION[input.relation]
          await tx.contactLink.upsert({
            where: {
              fromContactId_toContactId_relation: {
                fromContactId: input.toContactId,
                toContactId: input.fromContactId,
                relation: inverseRel,
              },
            },
            create: {
              id: createId(),
              fromContactId: input.toContactId,
              toContactId: input.fromContactId,
              relation: inverseRel,
              notes: input.notes ?? null,
              createdById: user.id,
            },
            update: {},
          })
          return forward
        })
        await ctx.audit({
          action: 'contact.link_added',
          target: { type: 'Contact', id: input.fromContactId },
          after: {
            linkId: result.id,
            toContactId: input.toContactId,
            relation: input.relation,
          },
        })
        return { id: result.id }
      }),

    remove: auditedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const link = await ctx.db.contactLink.findUnique({ where: { id: input.id } })
        if (!link) throw new TRPCError({ code: 'NOT_FOUND' })
        await ctx.db.$transaction(async (tx) => {
          await tx.contactLink.delete({ where: { id: link.id } })
          // Remove the reciprocal too if it exists.
          await tx.contactLink.deleteMany({
            where: {
              fromContactId: link.toContactId,
              toContactId: link.fromContactId,
              relation: INVERSE_RELATION[link.relation],
            },
          })
        })
        await ctx.audit({
          action: 'contact.link_removed',
          target: { type: 'Contact', id: link.fromContactId },
          before: {
            linkId: link.id,
            toContactId: link.toContactId,
            relation: link.relation,
          },
        })
        return { id: link.id }
      }),

    // Pick-list of candidates for the link picker. Cheap prefix search across
    // name/email/phone, excluding the current contact.
    candidates: protectedProcedure
      .input(
        z.object({
          excludeContactId: z.string(),
          q: z.string().trim().min(1).max(120),
          limit: z.number().int().min(1).max(20).default(8),
        }),
      )
      .query(async ({ ctx, input }) => {
        const rows = await ctx.db.contact.findMany({
          where: {
            deletedAt: null,
            id: { not: input.excludeContactId },
            OR: [
              { firstName: { contains: input.q, mode: 'insensitive' } },
              { lastName: { contains: input.q, mode: 'insensitive' } },
              { email: { contains: input.q, mode: 'insensitive' } },
              { phoneE164: { contains: input.q } },
            ],
          },
          take: input.limit,
          select: {
            id: true,
            kind: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneE164: true,
          },
          orderBy: [{ createdAt: 'desc' }],
        })
        return rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          displayName: displayNameOf(r),
          email: r.email,
          phoneE164: r.phoneE164,
        }))
      }),
  }),
})
