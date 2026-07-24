// Contact router. See CLAUDE.md Sections 27, 20.
// All mutations are audited (auditedProcedure runtime-checks ctx.audit was called).

import { createId } from '@paralleldrive/cuid2'
import type { Prisma } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { writeAuditLogEntry } from '@studymind/audit'

import { eraseContactData } from '@studymind/core/compliance/erase-contact'

import { phoneSearchDigitRuns } from '@studymind/core/contact/phone-search'
import { BusinessError } from '@studymind/core/errors'

import { addContactCallSummary } from '@studymind/core/contact/call-summary'
import {
  addContactDocument,
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  InvalidDocumentError,
  listContactDocuments,
  removeContactDocument,
} from '@studymind/core/contact/documents'

import { postCallSummaryToSlack } from '@/lib/board/call-summary-senders'
import {
  MailchimpError,
  MailchimpNotConfiguredError,
  pushContactToMailchimp,
} from '@/lib/mailchimp/outbound'

import {
  ContactCreateInput,
  ContactLinkRelation,
  ContactSummary,
  ContactUpdateInput,
  displayNameOf,
  INVERSE_RELATION,
  isMinorByDob,
} from '@studymind/core/contact'

import {
  loadContactCommsCounts,
  loadContactComplaintCounts,
  loadContactEnquiryTypes,
} from '@studymind/core/stats'

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
  /**
   * 1-based page for offset pagination. When supplied the list returns that
   * page (skip = (page-1)*limit) instead of cursor-paginating, so the UI can
   * show "page X of Y" + a total. Cursor mode (omit `page`) is retained for
   * the CSV export streamer and the typeahead callers.
   */
  page: z.number().int().min(1).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  /** Filter by Company.id (m2m — matches contacts tagged with this brand). */
  companyId: z.string().nullish(),
  /** Multi-select brand filter (OR within companies). Supersedes companyId. */
  companyIds: z.array(z.string()).max(50).optional(),
  /** Filter by Subject.id (m2m). */
  subjectId: z.string().nullish(),
  /** Multi-select subject filter (OR within subjects). Supersedes subjectId. */
  subjectIds: z.array(z.string()).max(50).optional(),
  /** Filter by Contact.country (exact stored values, OR). Options come from
   * `filterFacets` so they always match what's in the column. */
  countries: z.array(z.string().trim().min(1).max(120)).max(60).optional(),
  /** Contacts whose web enquiries carried ANY of these classification
   * categories ("Summer Camp", "UCAT", …). Matched against the categories on
   * leads converted to the contact. */
  enquiryCategories: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  /** Filter by contact kind. */
  kind: z.enum(['unclassified', 'parent', 'student', 'tutor', 'other']).optional(),
  /** Multi-select kind filter (OR). Supersedes kind. */
  kinds: z
    .array(z.enum(['unclassified', 'parent', 'student', 'tutor', 'other']))
    .max(10)
    .optional(),
  /** Filter by booking lifecycle (CLAUDE.md §15). */
  bookingStatus: z.enum(['lead', 'registered_no_hours', 'registered_with_hours']).optional(),
  /** Multi-select booking-status filter (OR). Supersedes bookingStatus. */
  bookingStatuses: z
    .array(z.enum(['lead', 'registered_no_hours', 'registered_with_hours']))
    .max(5)
    .optional(),
  /** Only contacts that belong to a Family (or only those who don't). */
  hasFamily: z.boolean().optional(),
  /** Filter to customers carrying ALL of these shared-catalogue label ids. */
  labelIds: z.array(z.string()).max(20).optional(),
  /** Hours range filters on the booking-derived columns (ADR 0029). Inclusive. */
  minHoursBooked: z.number().int().min(0).optional(),
  maxHoursBooked: z.number().int().min(0).optional(),
  minHoursDelivered: z.number().int().min(0).optional(),
  maxHoursDelivered: z.number().int().min(0).optional(),
  /** Only customers whose most recent lesson was at least this many days ago. */
  lastLessonBeforeDays: z.number().int().min(0).optional(),
  /**
   * Sort field. `createdAt` (default) and `name`, plus the booking-derived
   * hours columns. All sort on real Contact columns so cursor pagination stays
   * correct. (Derived hours-remaining + risk ordering live on the dedicated
   * at-risk dashboard, which is not cursor-paginated.)
   */
  sortBy: z
    .enum(['createdAt', 'name', 'hoursBooked', 'hoursDelivered', 'lastLessonAt'])
    .default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
})

function newId(): string {
  return createId()
}

export const contactRouter = router({
  list: protectedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    // Sorts on a real Contact column + an id tiebreak. Nulls land last on
    // the booking-derived columns (a contact without a synced balance should
    // not top a "most hours" sort). Cursor pagination is only engaged for
    // the default createdAt sort (below); the hours sorts return the first
    // page sized to the limit, which is what the table needs.
    const dir = input.sortDir
    let orderBy: Array<Record<string, unknown>>
    switch (input.sortBy) {
      case 'name':
        orderBy = [{ lastName: dir }, { firstName: dir }, { id: 'desc' }]
        break
      case 'hoursBooked':
        orderBy = [{ hoursBooked: { sort: dir, nulls: 'last' } }, { id: 'desc' }]
        break
      case 'hoursDelivered':
        orderBy = [{ hoursDelivered: { sort: dir, nulls: 'last' } }, { id: 'desc' }]
        break
      case 'lastLessonAt':
        orderBy = [{ lastLessonAt: { sort: dir, nulls: 'last' } }, { id: 'desc' }]
        break
      default:
        // The id tiebreak must track the sort direction so it agrees with the
        // keyset cursor below (asc branch uses `id > cursor`, desc uses `<`).
        // A hardcoded `id: desc` skipped/duplicated equal-createdAt rows across
        // pages when sorting ascending.
        orderBy = [{ createdAt: dir }, { id: dir }]
    }

    const lastLessonCutoff =
      input.lastLessonBeforeDays != null
        ? new Date(Date.now() - input.lastLessonBeforeDays * 24 * 60 * 60 * 1000)
        : null

    // Enquiry-category filter: Lead has no Prisma relation to Contact
    // (convertedToContactId is a plain column), so resolve the matching
    // contact ids up front and filter on `id IN`.
    let enquiryContactIds: string[] | null = null
    if (input.enquiryCategories && input.enquiryCategories.length > 0) {
      const leads = await ctx.db.lead.findMany({
        where: {
          deletedAt: null,
          convertedToContactId: { not: null },
          categories: { hasSome: input.enquiryCategories },
        },
        select: { convertedToContactId: true },
        distinct: ['convertedToContactId'],
        take: 10_000,
      })
      enquiryContactIds = leads
        .map((l) => l.convertedToContactId)
        .filter((id): id is string => !!id)
    }

    // Every filter EXCEPT the keyset cursor — shared by the count and the
    // page read so "total" reflects the whole filtered set. Plural filter
    // params (multi-select UI) win over their singular back-compat twin.
    const filterWhere: Prisma.ContactWhereInput = {
      deletedAt: null,
      ...(input.kinds && input.kinds.length > 0
        ? { kind: { in: input.kinds } }
        : input.kind
          ? { kind: input.kind }
          : {}),
      ...(input.bookingStatuses && input.bookingStatuses.length > 0
        ? { bookingStatus: { in: input.bookingStatuses } }
        : input.bookingStatus
          ? { bookingStatus: input.bookingStatus }
          : {}),
      ...(input.hasFamily !== undefined
        ? input.hasFamily
          ? { familyMembers: { some: {} } }
          : { familyMembers: { none: {} } }
        : {}),
      ...(input.companyIds && input.companyIds.length > 0
        ? { companies: { some: { companyId: { in: input.companyIds } } } }
        : input.companyId
          ? { companies: { some: { companyId: input.companyId } } }
          : {}),
      ...(input.subjectIds && input.subjectIds.length > 0
        ? { subjects: { some: { subjectId: { in: input.subjectIds } } } }
        : input.subjectId
          ? { subjects: { some: { subjectId: input.subjectId } } }
          : {}),
      ...(input.countries && input.countries.length > 0
        ? { country: { in: input.countries } }
        : {}),
      ...(enquiryContactIds ? { id: { in: enquiryContactIds } } : {}),
      // AND semantics: a customer must carry every requested label.
      ...(input.labelIds && input.labelIds.length > 0
        ? { AND: input.labelIds.map((id) => ({ labels: { some: { labelId: id } } })) }
        : {}),
      ...(input.minHoursBooked != null || input.maxHoursBooked != null
        ? {
            hoursBooked: {
              ...(input.minHoursBooked != null ? { gte: input.minHoursBooked } : {}),
              ...(input.maxHoursBooked != null ? { lte: input.maxHoursBooked } : {}),
            },
          }
        : {}),
      ...(input.minHoursDelivered != null || input.maxHoursDelivered != null
        ? {
            hoursDelivered: {
              ...(input.minHoursDelivered != null ? { gte: input.minHoursDelivered } : {}),
              ...(input.maxHoursDelivered != null ? { lte: input.maxHoursDelivered } : {}),
            },
          }
        : {}),
      ...(lastLessonCutoff ? { lastLessonAt: { lte: lastLessonCutoff } } : {}),
      ...(input.q
        ? {
            OR: [
              { firstName: { contains: input.q, mode: 'insensitive' } },
              { lastName: { contains: input.q, mode: 'insensitive' } },
              { email: { contains: input.q, mode: 'insensitive' } },
              { phoneE164: { contains: input.q } },
              // Phone-shaped queries match by digit run so spaces, the
              // country code, and the trunk 0 are all optional (§29).
              ...phoneSearchDigitRuns(input.q).map((run) => ({
                phoneE164: { contains: run },
              })),
            ],
          }
        : {}),
    }

    // Keyset cursor (only meaningful for the default createdAt sort). Combined
    // with the filters via a top-level AND so the search `OR` is preserved.
    const cursorWhere: Prisma.ContactWhereInput | null =
      input.page == null && input.cursor && input.sortBy === 'createdAt'
        ? input.sortDir === 'desc'
          ? {
              OR: [
                { createdAt: { lt: input.cursor.createdAt } },
                {
                  AND: [{ createdAt: input.cursor.createdAt }, { id: { lt: input.cursor.id } }],
                },
              ],
            }
          : {
              OR: [
                { createdAt: { gt: input.cursor.createdAt } },
                {
                  AND: [{ createdAt: input.cursor.createdAt }, { id: { gt: input.cursor.id } }],
                },
              ],
            }
        : null

    const usingOffset = input.page != null

    const [total, rows] = await Promise.all([
      ctx.db.contact.count({ where: filterWhere }),
      ctx.db.contact.findMany({
        where: cursorWhere ? { AND: [filterWhere, cursorWhere] } : filterWhere,
        orderBy,
        ...(usingOffset
          ? { skip: (input.page! - 1) * input.limit, take: input.limit }
          : { take: input.limit + 1 }),
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
          companies: {
            include: {
              company: { select: { id: true, name: true, slug: true, color: true } },
            },
          },
          labels: {
            include: { label: { select: { id: true, name: true, color: true } } },
          },
          subjects: {
            include: { subject: { select: { id: true, name: true } } },
          },
          bookingProfile: { select: { hoursRemaining: true, nextHoursExpiryAt: true } },
        },
      }),
    ])

    const hasMore = !usingOffset && rows.length > input.limit
    const sliced = hasMore ? rows.slice(0, input.limit) : rows
    const pageIds = sliced.map((r) => r.id)
    // Three batched reads for the whole page: comms counts, active
    // complaints, and enquiry types. One extra query each, regardless of
    // page size.
    const [counts, complaints, enquiryTypes] = await Promise.all([
      loadContactCommsCounts(ctx.db, pageIds),
      loadContactComplaintCounts(ctx.db, pageIds),
      loadContactEnquiryTypes(ctx.db, pageIds),
    ])
    const items: ContactSummary[] = sliced.map((r) =>
      toContactSummary(
        r,
        counts.get(r.id),
        new Date(),
        complaints.get(r.id) ?? 0,
        enquiryTypes.get(r.id) ?? [],
      ),
    )
    const last = sliced[sliced.length - 1]
    const nextCursor = hasMore && last ? { id: last.id, createdAt: last.createdAt } : null
    return { items, nextCursor, total }
  }),

  /** Facet options for the B2C list filters that have no fixed value set:
   * the countries actually stored on contacts and the enquiry categories
   * actually seen on classified leads ("Summer Camp", "UCAT", …). Both grow
   * automatically as ops add classification rules or new countries enquire. */
  filterFacets: protectedProcedure.query(async ({ ctx }) => {
    const [countryGroups, recentLeads] = await Promise.all([
      ctx.db.contact.groupBy({
        by: ['country'],
        where: { deletedAt: null, country: { not: null } },
        _count: { _all: true },
      }),
      ctx.db.lead.findMany({
        where: {
          deletedAt: null,
          convertedToContactId: { not: null },
          categories: { isEmpty: false },
        },
        select: { categories: true },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      }),
    ])
    const countries = countryGroups
      .flatMap((g) => (g.country ? [{ value: g.country, count: g._count._all }] : []))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    const enquiryCategories = [...new Set(recentLeads.flatMap((l) => l.categories))].sort((a, b) =>
      a.localeCompare(b),
    )
    return { countries, enquiryCategories }
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
          companies: {
            include: {
              company: { select: { id: true, name: true, slug: true, color: true } },
            },
          },
          subjects: {
            include: { subject: { select: { id: true, name: true } } },
          },
        },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      const viewer = requireUser(ctx)
      // Per-record access log (compliance activity viewer): record every
      // open of a contact record — the "who viewed this" trail the audit
      // surface renders. Queries don't run auditMiddleware, so write directly.
      // requestId gives the writer's built-in dedupe, so a component refetch
      // within one request writes a single row, not one per re-render.
      await writeAuditLogEntry(ctx.db, {
        actorId: viewer.id,
        action: 'contact.viewed',
        target: { type: 'Contact', id: row.id },
        requestId: ctx.requestId,
        purpose: input.purpose ?? 'contact.read',
      })
      // §20.1 / §21: reads of a MINOR's profile carry the stricter,
      // separate compliance action as well (this query returns
      // dateOfBirth + isMinor).
      if (row.isMinor) {
        await writeAuditLogEntry(ctx.db, {
          actorId: viewer.id,
          action: 'contact.read_minor',
          target: { type: 'Contact', id: row.id },
          purpose: input.purpose ?? 'contact.read',
        })
      }
      const enquiryTypes = (await loadContactEnquiryTypes(ctx.db, [row.id])).get(row.id) ?? []
      return toContactDetail(row, enquiryTypes)
    }),

  create: auditedProcedure.input(ContactCreateInput).mutation(async ({ ctx, input }) => {
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
        preferredContactMethod: input.preferredContactMethod ?? null,
        timezone: input.timezone ?? null,
        referralSource: input.referralSource ?? null,
        examTarget: input.examTarget ?? null,
        createdById: user.id,
        updatedById: user.id,
        ...(input.companyIds && input.companyIds.length > 0
          ? {
              companies: {
                create: input.companyIds.map((companyId) => ({
                  companyId,
                  createdById: user.id,
                })),
              },
            }
          : {}),
        ...(input.subjectIds && input.subjectIds.length > 0
          ? {
              subjects: {
                create: input.subjectIds.map((subjectId) => ({
                  subjectId,
                  createdById: user.id,
                })),
              },
            }
          : {}),
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

  update: auditedProcedure.input(ContactUpdateInput).mutation(async ({ ctx, input }) => {
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
        // Reclassification: undefined leaves the kind unchanged (Prisma
        // ignores undefined), so existing callers that omit it are unaffected.
        kind: input.kind,
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
        preferredContactMethod: pass(input.preferredContactMethod),
        timezone: pass(input.timezone),
        referralSource: pass(input.referralSource),
        examTarget: pass(input.examTarget),
        // m2m: replace the whole set when the array is sent. Undefined =
        // don't touch. Empty array = clear.
        ...(input.companyIds !== undefined
          ? {
              companies: {
                deleteMany: {},
                create: input.companyIds.map((companyId) => ({
                  companyId,
                  createdById: user.id,
                })),
              },
            }
          : {}),
        ...(input.subjectIds !== undefined
          ? {
              subjects: {
                deleteMany: {},
                create: input.subjectIds.map((subjectId) => ({
                  subjectId,
                  createdById: user.id,
                })),
              },
            }
          : {}),
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

    // Two-way sync: if an identity field changed on a Summer Camp-linked
    // contact, push it back to the camp booking. Best-effort; a no-op for
    // non-camp contacts (CLAUDE.md §15 summer-camp write-back).
    const identityTouched =
      input.firstName !== undefined ||
      input.lastName !== undefined ||
      input.email !== undefined ||
      input.phoneE164 !== undefined
    if (identityTouched) {
      const { pushContactDetailsForContact } =
        await import('@studymind/integration-summer-camp/writeback')
      await pushContactDetailsForContact(ctx.db, after.id).catch(() => null)
    }

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
        // Read of AI merge candidates: every sales role — Sales Executive AND
        // Virtual Assistant now share the full capability set (operator
        // decision 2026-07, §20).
        if (
          !['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'].includes(
            user.role,
          )
        ) {
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
              ...phoneSearchDigitRuns(input.q).map((run) => ({
                phoneE164: { contains: run },
              })),
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

  // Documents — small files attached to a contact (EHCPs, school letters,
  // intake forms). Bytes live in Postgres so a self-hosted install needs no
  // S3. CEO / Senior Manager / Manager / Sales Executive can upload; everyone
  // can read.
  documents: router({
    list: protectedProcedure
      .input(z.object({ contactId: z.string() }))
      .query(async ({ ctx, input }) => {
        const rows = await listContactDocuments(ctx.db, input.contactId)
        return rows
      }),

    add: auditedProcedure
      .input(
        z.object({
          contactId: z.string(),
          fileName: z.string().trim().min(1).max(255),
          contentType: z.enum(ALLOWED_DOCUMENT_CONTENT_TYPES),
          description: z.string().trim().max(500).optional(),
          // Base64 payload — capped at ~11 MB (8 MB binary * 1.37) which is the
          // ContactDocument size limit.
          dataBase64: z.string().min(1).max(12_000_000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        const data = Buffer.from(input.dataBase64, 'base64')
        try {
          const id = createId()
          const row = await addContactDocument(ctx.db, {
            id,
            contactId: input.contactId,
            fileName: input.fileName,
            contentType: input.contentType,
            data,
            description: input.description ?? null,
            actorId: user.id,
          })
          await ctx.audit({
            action: 'contact.document_added',
            target: { type: 'Contact', id: input.contactId },
            after: {
              documentId: row.id,
              fileName: input.fileName,
              contentType: input.contentType,
              byteSize: row.byteSize,
            },
          })
          return { id: row.id, byteSize: row.byteSize }
        } catch (err) {
          if (err instanceof InvalidDocumentError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw err
        }
      }),

    remove: auditedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const before = await ctx.db.contactDocument.findUnique({
          where: { id: input.id },
          select: { contactId: true, fileName: true, contentType: true, byteSize: true },
        })
        if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
        await removeContactDocument(ctx.db, input.id)
        await ctx.audit({
          action: 'contact.document_removed',
          target: { type: 'Contact', id: before.contactId },
          before: {
            documentId: input.id,
            fileName: before.fileName,
            contentType: before.contentType,
            byteSize: before.byteSize,
          },
        })
        return { id: input.id }
      }),
  }),

  // Call summary — a staff member types the outcome of a call against the
  // contact; it is recorded on the CRM and announced to `#callsummaries`
  // (best-effort). No customer message is sent from the CRM (redesign 2026-07).
  callSummary: router({
    add: auditedProcedure
      .input(
        z.object({
          contactId: z.string(),
          body: z.string().trim().min(1).max(8000),
          outcome: z.enum(['answered', 'voicemail', 'no_answer']).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        try {
          const result = await addContactCallSummary(
            ctx.db,
            {
              contactId: input.contactId,
              body: input.body,
              outcome: input.outcome ?? null,
            },
            { actorId: user.id, requestId: ctx.requestId },
          )
          // Core writer audits via writeAuditLogEntry — satisfy the
          // auditedProcedure runtime check.
          ctx.audit.called = true
          // Announce to `#callsummaries` (best-effort — a Slack failure never
          // loses the CRM record we just wrote).
          const slack = await postCallSummaryToSlack({
            contactId: input.contactId,
            body: input.body,
            outcome: input.outcome ?? null,
            agentId: user.id,
            requestId: ctx.requestId,
          })
          return { id: result.id, occurredAt: result.occurredAt, slack }
        } catch (err) {
          if (err instanceof BusinessError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw err
        }
      }),
  }),

  // Mailchimp upsert. Pushes the contact (using mailchimpEmail if set, else
  // the regular email) to the configured audience. Idempotent on email hash.
  /** Bulk soft-delete a list of contacts (Manager+). Skips ids that don't
   * exist or are already deleted. Returns the count actually deleted. */
  /** Merge a set of duplicate contacts into one survivor. The survivor is
   * kept; every other id is merged into it (interactions / family / billing
   * re-parented, loser soft-deleted) one at a time so a single bad row
   * doesn't abort the batch. Manager+ only — same gate as single merge. */
  bulkMerge: auditedProcedure
    .input(
      z.object({
        survivorId: z.string(),
        loserIds: z.array(z.string()).min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!['ceo', 'senior_manager', 'manager'].includes(user.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only Manager or above can merge contacts',
        })
      }
      // Guard: survivor can't be in the loser set.
      const losers = input.loserIds.filter((id) => id !== input.survivorId)
      if (losers.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Pick at least one other contact to merge into the survivor.',
        })
      }
      const results: Array<{
        loserId: string
        status: 'merged' | 'failed'
        detail?: string
        movedInteractions?: number
      }> = []
      for (const loserId of losers) {
        try {
          const r = await mergeContacts(ctx.db, {
            survivorId: input.survivorId,
            loserId,
            actorUserId: user.id,
          })
          results.push({
            loserId,
            status: 'merged',
            movedInteractions: r.movedInteractions,
          })
        } catch (err) {
          results.push({
            loserId,
            status: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const mergedCount = results.filter((r) => r.status === 'merged').length
      await ctx.audit({
        action: 'contact.merged',
        target: { type: 'Contact', id: input.survivorId },
        after: {
          survivorId: input.survivorId,
          attempted: losers.length,
          merged: mergedCount,
          failed: losers.length - mergedCount,
        },
      })
      return { survivorId: input.survivorId, mergedCount, results }
    }),

  bulkSoftDelete: auditedProcedure
    .input(
      z.object({
        contactIds: z.array(z.string()).min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (user.role !== 'ceo' && user.role !== 'senior_manager' && user.role !== 'manager') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only Manager or above can bulk-delete contacts',
        })
      }
      const result = await ctx.db.contact.updateMany({
        where: { id: { in: input.contactIds }, deletedAt: null },
        data: { deletedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'soft_delete',
        target: { type: 'ContactBulk', id: `${result.count}` },
        before: { contactIds: input.contactIds },
        after: { deletedCount: result.count },
      })
      return { deletedCount: result.count }
    }),

  // ---------------------------------------------------------------------------
  // GDPR right-to-erasure (Article 17). CEO / Senior Manager only. §21.
  // `erase` is immediate + irreversible (crypto-shred + anonymise);
  // `scheduleErasure` soft-deletes with a 30-day grace the daily
  // `compliance/erase-due-records` cron then completes; `cancelErasure` stops
  // a scheduled erasure within the grace window.
  // ---------------------------------------------------------------------------
  erase: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        // The actor must retype the contact's name (or email) to confirm — a
        // deliberate friction step for an irreversible action.
        confirmName: z.string().min(1),
        reason: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (user.role !== 'ceo' && user.role !== 'senior_manager') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only a CEO or Senior Manager can permanently erase a contact.',
        })
      }
      const row = await ctx.db.contact.findFirst({
        where: { id: input.id },
        select: { id: true, firstName: true, lastName: true, email: true, erasedAt: true },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      const displayName = [row.firstName, row.lastName].filter(Boolean).join(' ').trim()
      const expected = (displayName || row.email || '').trim().toLowerCase()
      const provided = input.confirmName.trim().toLowerCase()
      // If the record has no name/email at all, require the literal word ERASE.
      const matches = expected ? provided === expected : provided === 'erase'
      if (!matches) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Confirmation does not match the contact — erasure aborted.',
        })
      }
      const result = await eraseContactData(ctx.db, {
        contactId: input.id,
        actorId: user.id,
        requestId: ctx.requestId,
        reason: input.reason ?? 'Manual erasure',
      })
      return result
    }),

  scheduleErasure: auditedProcedure
    .input(z.object({ id: z.string(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (user.role !== 'ceo' && user.role !== 'senior_manager') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only a CEO or Senior Manager can schedule an erasure.',
        })
      }
      const before = await ctx.db.contact.findFirst({
        where: { id: input.id, erasedAt: null },
        select: { id: true, deletedAt: true, erasureScheduledAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const now = new Date()
      const scheduledAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      await ctx.db.contact.update({
        where: { id: input.id },
        data: {
          deletedAt: before.deletedAt ?? now,
          erasureScheduledAt: scheduledAt,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'contact.erasure_scheduled',
        target: { type: 'Contact', id: input.id },
        after: { erasureScheduledAt: scheduledAt, reason: input.reason ?? null },
      })
      return { erasureScheduledAt: scheduledAt }
    }),

  cancelErasure: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (user.role !== 'ceo' && user.role !== 'senior_manager') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only a CEO or Senior Manager can cancel an erasure.',
        })
      }
      const before = await ctx.db.contact.findFirst({
        where: { id: input.id, erasedAt: null },
        select: { id: true, erasureScheduledAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.contact.update({
        where: { id: input.id },
        data: { erasureScheduledAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'contact.erasure_cancelled',
        target: { type: 'Contact', id: input.id },
        before: { erasureScheduledAt: before.erasureScheduledAt },
      })
      return { ok: true as const }
    }),

  /** Bulk-push a list of contacts to the Mailchimp audience. Per-id failures
   * are collected and returned so the UI can show a per-row toast.
   * Sales Executive+. */
  bulkMailchimpPush: auditedProcedure
    .input(
      z.object({
        contactIds: z.array(z.string()).min(1).max(200),
        listId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.contact.findMany({
        where: { id: { in: input.contactIds }, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          mailchimpEmail: true,
        },
      })
      const results: Array<{
        contactId: string
        status: 'pushed' | 'skipped' | 'failed'
        detail?: string
      }> = []
      for (const c of rows) {
        const email = (c.mailchimpEmail ?? c.email)?.trim()
        if (!email) {
          results.push({ contactId: c.id, status: 'skipped', detail: 'No email' })
          continue
        }
        try {
          const pushed = await pushContactToMailchimp({
            email,
            firstName: c.firstName,
            lastName: c.lastName,
            listId: input.listId,
          })
          results.push({
            contactId: c.id,
            status: 'pushed',
            detail: pushed.status,
          })
        } catch (err) {
          results.push({
            contactId: c.id,
            status: 'failed',
            detail: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const pushedCount = results.filter((r) => r.status === 'pushed').length
      await ctx.audit({
        action: 'contact.mailchimp_pushed',
        target: { type: 'ContactBulk', id: `${input.contactIds.length}` },
        after: {
          attempted: input.contactIds.length,
          pushed: pushedCount,
          skipped: results.filter((r) => r.status === 'skipped').length,
          failed: results.filter((r) => r.status === 'failed').length,
          listId: input.listId ?? null,
        },
      })
      return { pushedCount, results }
    }),

  mailchimp: router({
    push: auditedProcedure
      .input(z.object({ contactId: z.string(), listId: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            mailchimpEmail: true,
          },
        })
        if (!contact) throw new TRPCError({ code: 'NOT_FOUND' })
        const email = (contact.mailchimpEmail ?? contact.email)?.trim()
        if (!email) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No email on this contact to push to Mailchimp.',
          })
        }
        try {
          const result = await pushContactToMailchimp({
            email,
            firstName: contact.firstName,
            lastName: contact.lastName,
            listId: input.listId,
          })
          await ctx.audit({
            action: 'contact.mailchimp_pushed',
            target: { type: 'Contact', id: contact.id },
            after: {
              email,
              listId: input.listId ?? null,
              subscriberHash: result.subscriberHash,
              status: result.status,
            },
          })
          return result
        } catch (err) {
          if (err instanceof MailchimpNotConfiguredError) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: err.message,
            })
          }
          if (err instanceof MailchimpError) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `${err.message}${err.detail ? `: ${err.detail}` : ''}`,
            })
          }
          throw err
        }
      }),
  }),
})
