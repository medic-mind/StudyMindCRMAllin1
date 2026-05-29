// B2B accounts (schools + partnership organisations). Mirrors the `company`
// router shape (list / pickList / create / update / archive / restore) with
// the addition of:
//   - kind filter (`school | partnership`) on every list query, so the UI
//     can dedicate a tab per kind without overloading the API.
//   - status lifecycle (`prospect | active | paused | churned`).
//   - contacts subrouter to link / unlink Contacts (with an optional role
//     string like "Head teacher", "SENCo", "Programme lead").
//   - rich detail surface: org-level contact email/phone, website, address,
//     free-form notes.
//
// CLAUDE.md §20.1 — Manager+ for writes; all authenticated roles read.

import { createId } from '@paralleldrive/cuid2'
import { BusinessAccountKind, BusinessAccountStatus } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

function assertCanManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager or above can manage B2B accounts',
    })
  }
}

const HEX_COLOR = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/u, 'Use a #RRGGBB hex colour')

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

const KindEnum = z.nativeEnum(BusinessAccountKind)
const StatusEnum = z.nativeEnum(BusinessAccountStatus)

const CreateInput = z.object({
  kind: KindEnum,
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(60).optional(),
  color: HEX_COLOR.optional(),
  description: z.string().trim().max(280).optional(),
  status: StatusEnum.optional(),
  contactEmail: z.string().trim().email().optional().or(z.literal('')),
  contactPhone: z.string().trim().max(40).optional(),
  website: z.string().trim().url().optional().or(z.literal('')),
  addressLine1: z.string().trim().max(120).optional(),
  addressLine2: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  postcode: z.string().trim().max(20).optional(),
  country: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(8000).optional(),
})

const UpdateInput = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(60).optional(),
  color: HEX_COLOR.nullish(),
  description: z.string().trim().max(280).nullish(),
  status: StatusEnum.optional(),
  contactEmail: z.string().trim().email().nullish().or(z.literal('')),
  contactPhone: z.string().trim().max(40).nullish(),
  website: z.string().trim().url().nullish().or(z.literal('')),
  addressLine1: z.string().trim().max(120).nullish(),
  addressLine2: z.string().trim().max(120).nullish(),
  city: z.string().trim().max(80).nullish(),
  postcode: z.string().trim().max(20).nullish(),
  country: z.string().trim().max(80).nullish(),
  notes: z.string().trim().max(8000).nullish(),
})

function emptyToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const t = v.trim()
  return t.length === 0 ? null : t
}

const contactsRouter = router({
  /** Link a Contact to a B2B account with an optional role string. */
  link: auditedProcedure
    .input(
      z.object({
        accountId: z.string(),
        contactId: z.string(),
        role: z.string().trim().max(80).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const account = await ctx.db.businessAccount.findUnique({
        where: { id: input.accountId },
      })
      if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
      const contact = await ctx.db.contact.findFirst({
        where: { id: input.contactId, deletedAt: null },
        select: { id: true },
      })
      if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      const link = await ctx.db.businessAccountContact.upsert({
        where: {
          accountId_contactId: { accountId: input.accountId, contactId: input.contactId },
        },
        create: {
          accountId: input.accountId,
          contactId: input.contactId,
          role: input.role ?? null,
          createdById: user.id,
        },
        update: {
          role: input.role ?? null,
        },
      })
      await ctx.audit({
        action: 'business_account.contact_linked',
        target: { type: 'BusinessAccount', id: input.accountId },
        after: {
          accountId: input.accountId,
          contactId: input.contactId,
          role: link.role,
        },
      })
      return { ok: true as const }
    }),

  /** Unlink a Contact from a B2B account. */
  unlink: auditedProcedure
    .input(z.object({ accountId: z.string(), contactId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const existing = await ctx.db.businessAccountContact.findUnique({
        where: {
          accountId_contactId: { accountId: input.accountId, contactId: input.contactId },
        },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.businessAccountContact.delete({
        where: {
          accountId_contactId: { accountId: input.accountId, contactId: input.contactId },
        },
      })
      await ctx.audit({
        action: 'business_account.contact_unlinked',
        target: { type: 'BusinessAccount', id: input.accountId },
        before: { accountId: input.accountId, contactId: input.contactId, role: existing.role },
      })
      return { ok: true as const }
    }),
})

export const businessAccountRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        kind: KindEnum.optional(),
        status: StatusEnum.optional(),
        q: z.string().trim().max(80).optional(),
        includeArchived: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.businessAccount.findMany({
        where: {
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.includeArchived ? {} : { archivedAt: null }),
          ...(input.q
            ? {
                OR: [
                  { name: { contains: input.q, mode: 'insensitive' as const } },
                  { city: { contains: input.q, mode: 'insensitive' as const } },
                  { contactEmail: { contains: input.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { contacts: true } } },
      })
      return rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        name: a.name,
        slug: a.slug,
        color: a.color,
        description: a.description,
        status: a.status,
        contactEmail: a.contactEmail,
        contactPhone: a.contactPhone,
        website: a.website,
        city: a.city,
        country: a.country,
        contactCount: a._count.contacts,
        archived: a.archivedAt != null,
        createdAt: a.createdAt,
      }))
    }),

  /** Lightweight selector — sorted, active only, optionally kind-scoped. */
  pickList: protectedProcedure
    .input(z.object({ kind: KindEnum.optional() }).default({}))
    .query(async ({ ctx, input }) => {
      return ctx.db.businessAccount.findMany({
        where: {
          archivedAt: null,
          ...(input.kind ? { kind: input.kind } : {}),
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, kind: true, color: true, slug: true },
      })
    }),

  /** Detail view-model. Lists linked contacts with their roles. */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const a = await ctx.db.businessAccount.findUnique({
        where: { id: input.id },
        include: {
          contacts: {
            include: {
              contact: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phoneE164: true,
                  jobTitle: true,
                  kind: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      if (!a) throw new TRPCError({ code: 'NOT_FOUND' })
      return {
        id: a.id,
        kind: a.kind,
        name: a.name,
        slug: a.slug,
        color: a.color,
        description: a.description,
        status: a.status,
        contactEmail: a.contactEmail,
        contactPhone: a.contactPhone,
        website: a.website,
        addressLine1: a.addressLine1,
        addressLine2: a.addressLine2,
        city: a.city,
        postcode: a.postcode,
        country: a.country,
        notes: a.notes,
        archived: a.archivedAt != null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        contacts: a.contacts.map((link) => ({
          contactId: link.contactId,
          role: link.role,
          firstName: link.contact.firstName,
          lastName: link.contact.lastName,
          email: link.contact.email,
          phoneE164: link.contact.phoneE164,
          jobTitle: link.contact.jobTitle,
          kind: link.contact.kind,
        })),
      }
    }),

  create: auditedProcedure
    .input(CreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const slug = input.slug ?? slugify(input.name)
      if (!slug) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Could not derive a slug' })
      }
      const id = createId()
      try {
        const created = await ctx.db.businessAccount.create({
          data: {
            id,
            kind: input.kind,
            name: input.name,
            slug,
            color: input.color ?? null,
            description: input.description ?? null,
            status: input.status ?? 'prospect',
            contactEmail: emptyToNull(input.contactEmail) ?? null,
            contactPhone: input.contactPhone ?? null,
            website: emptyToNull(input.website) ?? null,
            addressLine1: input.addressLine1 ?? null,
            addressLine2: input.addressLine2 ?? null,
            city: input.city ?? null,
            postcode: input.postcode ?? null,
            country: input.country ?? null,
            notes: input.notes ?? null,
            createdById: user.id,
            updatedById: user.id,
          },
        })
        await ctx.audit({
          action: 'business_account.created',
          target: { type: 'BusinessAccount', id: created.id },
          after: created,
        })
        return { id: created.id }
      } catch (err) {
        if (err instanceof Error && /Unique.*slug/i.test(err.message)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A B2B account with that slug already exists for this kind.',
          })
        }
        throw err
      }
    }),

  update: auditedProcedure
    .input(UpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.businessAccount.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.businessAccount.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          color: input.color,
          description: input.description,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.contactEmail !== undefined
            ? { contactEmail: emptyToNull(input.contactEmail) }
            : {}),
          ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
          ...(input.website !== undefined
            ? { website: emptyToNull(input.website) }
            : {}),
          ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
          ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.postcode !== undefined ? { postcode: input.postcode } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'business_account.updated',
        target: { type: 'BusinessAccount', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.businessAccount.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.businessAccount.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'business_account.archived',
        target: { type: 'BusinessAccount', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.businessAccount.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.businessAccount.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'business_account.restored',
        target: { type: 'BusinessAccount', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  contacts: contactsRouter,
})
