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
import {
  BusinessAccountKind,
  BusinessAccountStatus,
  BusinessAccountStudentStatus,
} from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { writeAuditLogEntry } from '@studymind/audit'

import { loadAccountStats } from '@studymind/core/stats'
import { BookingApiError, createClient, isConfigured } from '@studymind/integration-booking/client'

import { slackMentionsForAccount } from '@/lib/view-models/contact-channels'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['ceo', 'senior_manager', 'manager'])

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

// ---------------------------------------------------------------------------
// Students (BusinessAccountStudent). Tracks cohorts the account is sending
// us — what they're getting and hours contracted vs delivered. Hours
// delivered will be filled by the booking.studymind.co.uk sync once it
// lands; until then editable by hand. CLAUDE.md §15.
// ---------------------------------------------------------------------------

const StudentStatusEnum = z.nativeEnum(BusinessAccountStudentStatus)

const StudentCreateInput = z.object({
  accountId: z.string(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  yearGroup: z.string().trim().max(40).optional(),
  dateOfBirth: z.date().optional(),
  program: z.string().trim().max(280).optional(),
  hoursContracted: z.number().int().min(0).max(100_000).optional(),
  hoursDelivered: z.number().int().min(0).max(100_000).optional(),
  startDate: z.date().optional(),
  endDate: z.date().optional(),
  status: StudentStatusEnum.optional(),
  subjects: z.string().trim().max(280).optional(),
  notes: z.string().trim().max(4000).optional(),
  bookingStudentId: z.string().trim().max(120).optional(),
})

const StudentUpdateInput = z.object({
  id: z.string(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).nullish(),
  yearGroup: z.string().trim().max(40).nullish(),
  dateOfBirth: z.date().nullish(),
  program: z.string().trim().max(280).nullish(),
  hoursContracted: z.number().int().min(0).max(100_000).nullish(),
  hoursDelivered: z.number().int().min(0).max(100_000).nullish(),
  startDate: z.date().nullish(),
  endDate: z.date().nullish(),
  status: StudentStatusEnum.optional(),
  subjects: z.string().trim().max(280).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  bookingStudentId: z.string().trim().max(120).nullish(),
})

const studentsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        accountId: z.string(),
        includeArchived: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.businessAccountStudent.findMany({
        where: {
          accountId: input.accountId,
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ archivedAt: 'asc' }, { lastName: 'asc' }, { firstName: 'asc' }],
      })
      return rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        firstName: r.firstName,
        lastName: r.lastName,
        yearGroup: r.yearGroup,
        dateOfBirth: r.dateOfBirth,
        program: r.program,
        hoursContracted: r.hoursContracted,
        hoursDelivered: r.hoursDelivered,
        startDate: r.startDate,
        endDate: r.endDate,
        status: r.status,
        subjects: r.subjects,
        notes: r.notes,
        bookingStudentId: r.bookingStudentId,
        bookingLastSyncAt: r.bookingLastSyncAt,
        archived: r.archivedAt != null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }))
    }),

  create: auditedProcedure.input(StudentCreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const account = await ctx.db.businessAccount.findUnique({
      where: { id: input.accountId },
      select: { id: true },
    })
    if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
    const id = createId()
    const row = await ctx.db.businessAccountStudent.create({
      data: {
        id,
        accountId: input.accountId,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        yearGroup: input.yearGroup ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        program: input.program ?? null,
        hoursContracted: input.hoursContracted ?? null,
        hoursDelivered: input.hoursDelivered ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        status: input.status ?? 'active',
        subjects: input.subjects ?? null,
        notes: input.notes ?? null,
        bookingStudentId: input.bookingStudentId ?? null,
        createdById: user.id,
        updatedById: user.id,
      },
    })
    await ctx.audit({
      action: 'business_account.student_added',
      target: { type: 'BusinessAccount', id: input.accountId },
      after: {
        studentId: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        program: row.program,
      },
    })
    return { id: row.id }
  }),

  update: auditedProcedure.input(StudentUpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const before = await ctx.db.businessAccountStudent.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        accountId: true,
        firstName: true,
        lastName: true,
        status: true,
        hoursContracted: true,
        hoursDelivered: true,
      },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    const after = await ctx.db.businessAccountStudent.update({
      where: { id: input.id },
      data: {
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
        lastName: input.lastName,
        yearGroup: input.yearGroup,
        dateOfBirth: input.dateOfBirth,
        program: input.program,
        hoursContracted: input.hoursContracted,
        hoursDelivered: input.hoursDelivered,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(input.status !== undefined ? { status: input.status } : {}),
        subjects: input.subjects,
        notes: input.notes,
        bookingStudentId: input.bookingStudentId,
        updatedById: user.id,
      },
    })
    await ctx.audit({
      action: 'business_account.student_updated',
      target: { type: 'BusinessAccount', id: before.accountId },
      before,
      after: {
        studentId: after.id,
        firstName: after.firstName,
        lastName: after.lastName,
        status: after.status,
        hoursContracted: after.hoursContracted,
        hoursDelivered: after.hoursDelivered,
      },
    })
    return { id: after.id }
  }),

  archive: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const before = await ctx.db.businessAccountStudent.findUnique({
      where: { id: input.id },
      select: { id: true, accountId: true, firstName: true, lastName: true },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    await ctx.db.businessAccountStudent.update({
      where: { id: input.id },
      data: { archivedAt: new Date(), updatedById: user.id },
    })
    await ctx.audit({
      action: 'business_account.student_archived',
      target: { type: 'BusinessAccount', id: before.accountId },
      before,
    })
    return { id: input.id }
  }),

  /**
   * Pull this student's delivered hours from booking.studymind.co.uk (ADR 0029).
   * Looks the student up by `bookingStudentId` (the booking UUID) and writes the
   * delivered-hours figure + sync timestamp. Returns a `skipped` status — with a
   * human message — when the integration is unconfigured or no match is found, so
   * the UI can surface it without guessing. Read-only against the booking site.
   */
  syncFromBooking: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const row = await ctx.db.businessAccountStudent.findUnique({
        where: { id: input.id },
        select: { id: true, accountId: true, bookingStudentId: true },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      ctx.audit.called = true

      if (!isConfigured()) {
        return {
          status: 'skipped' as const,
          message: 'Booking site sync is not configured yet (BOOKING_API_TOKEN unset).',
          bookingStudentId: row.bookingStudentId,
          hoursDelivered: null,
        }
      }
      if (!row.bookingStudentId) {
        return {
          status: 'skipped' as const,
          message: 'No booking student id set on this row — add one to enable sync.',
          bookingStudentId: null,
          hoursDelivered: null,
        }
      }

      try {
        const student = await createClient().getStudent(row.bookingStudentId)
        const hoursDelivered = Math.round(student.balance.hoursUsed)
        await ctx.db.businessAccountStudent.update({
          where: { id: input.id },
          data: { hoursDelivered, bookingLastSyncAt: new Date(), updatedById: user.id },
        })
        return {
          status: 'synced' as const,
          message: `Synced ${hoursDelivered}h delivered from the booking site.`,
          bookingStudentId: row.bookingStudentId,
          hoursDelivered,
        }
      } catch (err) {
        if (err instanceof BookingApiError && err.status === 404) {
          return {
            status: 'skipped' as const,
            message: 'No matching student found on the booking site for that id.',
            bookingStudentId: row.bookingStudentId,
            hoursDelivered: null,
          }
        }
        throw err
      }
    }),
})

// ---------------------------------------------------------------------------
// Companies (sister-brand tags) on a B2B account. M:N replace semantics so
// the admin form just sends the full set on save and we diff. Mirrors the
// pattern used on Contact.
// ---------------------------------------------------------------------------

const companiesSubRouter = router({
  /** Replace the company set for an account. Manager+. */
  set: auditedProcedure
    .input(
      z.object({
        accountId: z.string(),
        companyIds: z.array(z.string()).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const account = await ctx.db.businessAccount.findUnique({
        where: { id: input.accountId },
        select: { id: true },
      })
      if (!account) throw new TRPCError({ code: 'NOT_FOUND' })
      // Validate every company id exists + is not archived.
      const companies =
        input.companyIds.length > 0
          ? await ctx.db.company.findMany({
              where: { id: { in: input.companyIds }, archivedAt: null },
              select: { id: true },
            })
          : []
      const validIds = new Set(companies.map((c) => c.id))
      const filtered = input.companyIds.filter((id) => validIds.has(id))
      const before = await ctx.db.businessAccountCompany.findMany({
        where: { accountId: input.accountId },
        select: { companyId: true },
      })
      await ctx.db.$transaction([
        ctx.db.businessAccountCompany.deleteMany({
          where: { accountId: input.accountId },
        }),
        ...(filtered.length > 0
          ? [
              ctx.db.businessAccountCompany.createMany({
                data: filtered.map((companyId) => ({
                  accountId: input.accountId,
                  companyId,
                  createdById: user.id,
                })),
              }),
            ]
          : []),
      ])
      await ctx.audit({
        action: 'business_account.updated',
        target: { type: 'BusinessAccount', id: input.accountId },
        before: { companyIds: before.map((b) => b.companyId) },
        after: { companyIds: filtered },
      })
      return { ok: true as const, companyIds: filtered }
    }),
})

// Notes / activity on a B2B account — parity with the customer view.
// Notes are Sales Executive+ to write (VA reads). CLAUDE.md §20.1.
const ACCOUNT_WRITE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function assertCanWriteAccount(role: UserRole): void {
  if (!ACCOUNT_WRITE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Sales Executive or above can write here' })
  }
}

const accountNotesRouter = router({
  list: protectedProcedure
    .input(z.object({ accountId: z.string(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.interaction.findMany({
        where: { businessAccountId: input.accountId, type: 'note', deletedAt: null },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: { id: true, occurredAt: true, summary: true, payload: true },
      })
      return rows.map((r) => {
        const p = (r.payload ?? {}) as { body?: unknown }
        return {
          id: r.id,
          occurredAt: r.occurredAt,
          body: typeof p.body === 'string' ? p.body : r.summary ?? '',
        }
      })
    }),

  add: auditedProcedure
    .input(z.object({ accountId: z.string(), body: z.string().trim().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanWriteAccount(user.role)
      const acct = await ctx.db.businessAccount.findFirst({
        where: { id: input.accountId },
        select: { id: true },
      })
      if (!acct) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
      const id = createId()
      await ctx.db.interaction.create({
        data: {
          id,
          type: 'note',
          businessAccountId: input.accountId,
          occurredAt: new Date(),
          summary: input.body.slice(0, 280),
          payload: { event: 'note.added', body: input.body, source: 'business_account' },
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'business_account.note_added',
        target: { type: 'BusinessAccount', id: input.accountId },
        after: { interactionId: id },
      })
      return { id }
    }),
})

// Slack mentions filed against this account — a dedicated, labelled section
// (channel, sender, category, original text, permalink), parity with the
// customer view's Slack section. Reads the same slack_summary Interactions the
// importer stamps with businessAccountId (§12).
const accountSlackRouter = router({
  list: protectedProcedure
    .input(z.object({ accountId: z.string(), limit: z.number().int().min(1).max(100).default(25) }))
    .query(async ({ ctx, input }) => {
      const { items } = await slackMentionsForAccount(ctx.db, {
        businessAccountId: input.accountId,
        limit: input.limit,
      })
      return items
    }),
})

const accountActivityRouter = router({
  list: protectedProcedure
    .input(z.object({ accountId: z.string(), limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.interaction.findMany({
        where: { businessAccountId: input.accountId, deletedAt: null },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
        select: { id: true, type: true, occurredAt: true, summary: true },
      })
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        occurredAt: r.occurredAt,
        summary: r.summary,
      }))
    }),
})

export const businessAccountRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        kind: KindEnum.optional(),
        /** Multi-select status filter (OR). */
        statuses: z.array(StatusEnum).max(4).optional(),
        q: z.string().trim().max(80).optional(),
        /** Filter to accounts carrying ALL of these label ids. */
        labelIds: z.array(z.string()).max(20).optional(),
        includeArchived: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.businessAccount.findMany({
        where: {
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.statuses && input.statuses.length > 0
            ? { status: { in: input.statuses } }
            : {}),
          ...(input.includeArchived ? {} : { archivedAt: null }),
          // AND semantics: an account must carry every requested label.
          ...(input.labelIds && input.labelIds.length > 0
            ? { AND: input.labelIds.map((id) => ({ labels: { some: { labelId: id } } })) }
            : {}),
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
        include: {
          _count: { select: { contacts: true } },
          companies: {
            include: {
              company: { select: { id: true, name: true, slug: true, color: true } },
            },
          },
          labels: {
            include: {
              label: { select: { id: true, name: true, color: true } },
            },
          },
        },
      })
      // Engagement aggregates (students, hours, spend, comms, last contacted)
      // for the whole page in a fixed handful of batched queries.
      const stats = await loadAccountStats(
        ctx.db,
        rows.map((a) => a.id),
      )
      return rows.map((a) => {
        const s = stats.get(a.id)
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
          city: a.city,
          country: a.country,
          contactCount: a._count.contacts,
          companies: a.companies.map((link) => ({
            id: link.company.id,
            name: link.company.name,
            slug: link.company.slug,
            color: link.company.color,
          })),
          labels: a.labels.map((link) => ({
            id: link.label.id,
            name: link.label.name,
            color: link.label.color,
          })),
          // Engagement (CLAUDE.md §27).
          studentCount: s?.studentCount ?? 0,
          hoursContracted: s?.hoursContracted ?? 0,
          hoursDelivered: s?.hoursDelivered ?? 0,
          amountPaidMinor: s?.amountPaidMinor ?? 0,
          callCount: s?.callCount ?? 0,
          textCount: s?.textCount ?? 0,
          emailCount: s?.emailCount ?? 0,
          lastContactedAt: s?.lastContactedAt ?? null,
          archived: a.archivedAt != null,
          createdAt: a.createdAt,
        }
      })
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
  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
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
        companies: {
          include: {
            company: { select: { id: true, name: true, slug: true, color: true } },
          },
        },
      },
    })
    if (!a) throw new TRPCError({ code: 'NOT_FOUND' })

    // Per-record access log: record who opened this school/partner account
    // (the B2B analogue of contact.viewed). Queries don't run auditMiddleware,
    // so write directly; requestId dedupes a same-request refetch. §20.
    await writeAuditLogEntry(ctx.db, {
      actorId: requireUser(ctx).id,
      action: 'business_account.viewed',
      target: { type: 'BusinessAccount', id: a.id },
      requestId: ctx.requestId,
    })

    // At-a-glance stats for the detail header band: engagement aggregates
    // (students, hours, paid, comms, last-contacted) plus a live rollup of the
    // invoices mirrored from the B2B Invoices Platform for this account.
    const [statsMap, invoiceRollup] = await Promise.all([
      loadAccountStats(ctx.db, [a.id]),
      ctx.db.invoicingInvoice.groupBy({
        by: ['status'],
        where: {
          deletedAt: null,
          customer: { businessAccountId: a.id },
        },
        _count: { _all: true },
        _sum: { grandTotalMinor: true, paidMinor: true },
      }),
    ])
    const stats = statsMap.get(a.id) ?? null
    let invoiceCount = 0
    let invoicedMinor = 0
    let invoicePaidMinor = 0
    let outstandingMinor = 0
    for (const row of invoiceRollup) {
      const n = row._count._all
      const grand = row._sum.grandTotalMinor ?? 0
      const paid = row._sum.paidMinor ?? 0
      invoiceCount += n
      invoicedMinor += grand
      invoicePaidMinor += paid
      // Outstanding excludes cancelled invoices.
      if (row.status !== 'cancelled') outstandingMinor += Math.max(0, grand - paid)
    }

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
      needsClassification: a.needsClassification,
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
      companies: a.companies.map((link) => ({
        id: link.company.id,
        name: link.company.name,
        slug: link.company.slug,
        color: link.company.color,
      })),
      stats: {
        studentCount: stats?.studentCount ?? 0,
        hoursContracted: stats?.hoursContracted ?? 0,
        hoursDelivered: stats?.hoursDelivered ?? 0,
        amountPaidMinor: stats?.amountPaidMinor ?? 0,
        callCount: stats?.callCount ?? 0,
        textCount: stats?.textCount ?? 0,
        emailCount: stats?.emailCount ?? 0,
        lastContactedAt: stats?.lastContactedAt ?? null,
        invoiceCount,
        invoicedMinor,
        invoicePaidMinor,
        outstandingMinor,
      },
    }
  }),

  create: auditedProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
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

  update: auditedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
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
        ...(input.website !== undefined ? { website: emptyToNull(input.website) } : {}),
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

  archive: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
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

  restore: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
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

  /**
   * Permanently delete an account. Hard delete — every child row
   * (contacts/students/companies/labels/uploaded invoices, and the invoicing
   * customer mirror) cascades at the DB layer. Irreversible, so it is audited
   * with the full before-snapshot for forensic replay (CLAUDE.md §3, §20.1).
   * Manager+ only.
   */
  delete: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const before = await ctx.db.businessAccount.findUnique({ where: { id: input.id } })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    await ctx.db.businessAccount.delete({ where: { id: input.id } })
    await ctx.audit({
      action: 'business_account.deleted',
      target: { type: 'BusinessAccount', id: input.id },
      before,
    })
    return { id: input.id }
  }),

  // ---------------------------------------------------------------------------
  // Bulk actions. Drive the multi-select toolbar on /accounts. Each writes one
  // audit row per affected account so the trail stays per-entity (CLAUDE.md
  // §20.1). All Manager+.
  // ---------------------------------------------------------------------------

  /** Archive (soft) or restore many accounts at once. */
  bulkArchive: auditedProcedure
    .input(
      z.object({
        ids: z.array(z.string()).min(1).max(200),
        restore: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const rows = await ctx.db.businessAccount.findMany({
        where: { id: { in: input.ids } },
        select: { id: true, archivedAt: true },
      })
      for (const row of rows) {
        await ctx.db.businessAccount.update({
          where: { id: row.id },
          data: { archivedAt: input.restore ? null : new Date(), updatedById: user.id },
        })
        await ctx.audit({
          action: input.restore ? 'business_account.restored' : 'business_account.archived',
          target: { type: 'BusinessAccount', id: row.id },
        })
      }
      return { count: rows.length }
    }),

  /** Permanently delete many accounts. Hard delete + cascade, per `delete`. */
  bulkDelete: auditedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const rows = await ctx.db.businessAccount.findMany({
        where: { id: { in: input.ids } },
      })
      for (const row of rows) {
        await ctx.db.businessAccount.delete({ where: { id: row.id } })
        await ctx.audit({
          action: 'business_account.deleted',
          target: { type: 'BusinessAccount', id: row.id },
          before: row,
        })
      }
      return { count: rows.length }
    }),

  /** Set the lifecycle status on many accounts at once. */
  bulkSetStatus: auditedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1).max(200), status: StatusEnum }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const rows = await ctx.db.businessAccount.findMany({
        where: { id: { in: input.ids } },
        select: { id: true, status: true },
      })
      for (const row of rows) {
        await ctx.db.businessAccount.update({
          where: { id: row.id },
          data: { status: input.status, updatedById: user.id },
        })
        await ctx.audit({
          action: 'business_account.updated',
          target: { type: 'BusinessAccount', id: row.id },
          before: { status: row.status },
          after: { status: input.status },
        })
      }
      return { count: rows.length }
    }),

  /**
   * Apply (or remove) a single label across many accounts in one click.
   * Idempotent: re-applying an existing label is a no-op via the composite PK.
   */
  bulkSetLabel: auditedProcedure
    .input(
      z.object({
        ids: z.array(z.string()).min(1).max(200),
        labelId: z.string(),
        /** `true` removes the label instead of applying it. */
        remove: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const label = await ctx.db.accountLabel.findUnique({
        where: { id: input.labelId },
        select: { id: true, name: true, archivedAt: true },
      })
      if (!label) throw new TRPCError({ code: 'NOT_FOUND', message: 'Label not found' })
      const accounts = await ctx.db.businessAccount.findMany({
        where: { id: { in: input.ids } },
        select: { id: true },
      })
      for (const account of accounts) {
        if (input.remove) {
          await ctx.db.businessAccountLabel.deleteMany({
            where: { accountId: account.id, labelId: label.id },
          })
        } else {
          await ctx.db.businessAccountLabel.upsert({
            where: { accountId_labelId: { accountId: account.id, labelId: label.id } },
            create: { accountId: account.id, labelId: label.id, createdById: user.id },
            update: {},
          })
        }
        await ctx.audit({
          action: input.remove
            ? 'business_account.label_removed'
            : 'business_account.label_added',
          target: { type: 'BusinessAccount', id: account.id },
          after: { labelId: label.id, label: label.name },
        })
      }
      return { count: accounts.length }
    }),

  // ---------------------------------------------------------------------------
  // Unsorted tray (B2B Invoices Platform backfill). Accounts imported from the
  // invoicing platform that the auto-classifier could not confidently file land
  // here with one-click "Class as School / Class as B2B Partner" buttons.
  // ---------------------------------------------------------------------------

  /** Count of accounts awaiting classification (drives the tray badge). */
  unsortedCount: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.businessAccount.count({
      where: { needsClassification: true, archivedAt: null },
    })
  }),

  /** List accounts awaiting classification, with the classifier's rationale. */
  unsortedList: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.businessAccount.findMany({
        where: { needsClassification: true, archivedAt: null },
        orderBy: [{ createdAt: 'desc' }],
        take: input.limit,
      })
      return rows.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        contactEmail: a.contactEmail,
        contactPhone: a.contactPhone,
        city: a.city,
        country: a.country,
        classificationReason: a.classificationReason,
        classificationConfidence: a.classificationConfidence,
        createdAt: a.createdAt,
      }))
    }),

  /** One-click classify: set the kind and clear the needs-classification flag.
   *  Manager+ (same tier as other account writes). */
  classify: auditedProcedure
    .input(z.object({ id: z.string(), kind: KindEnum }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.businessAccount.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.businessAccount.update({
        where: { id: input.id },
        data: {
          kind: input.kind,
          needsClassification: false,
          classificationReason: `classified by ${user.id}`,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'business_account.updated',
        target: { type: 'BusinessAccount', id: after.id },
        before,
        after,
      })
      return { id: after.id, kind: after.kind }
    }),

  contacts: contactsRouter,
  students: studentsRouter,
  notes: accountNotesRouter,
  activity: accountActivityRouter,
  slackMentions: accountSlackRouter,
  companies: companiesSubRouter,
})
