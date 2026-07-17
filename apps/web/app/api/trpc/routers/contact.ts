// Contact router. See CLAUDE.md Sections 27, 20.
// All mutations are audited (auditedProcedure runtime-checks ctx.audit was called).

import { createId } from '@paralleldrive/cuid2'
import type { Prisma } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { phoneSearchDigitRuns } from '@studymind/core/contact/phone-search'
import { BusinessError } from '@studymind/core/errors'

import {
  buildCallSummaryDraftPrompt,
  buildCallSummaryScaffold,
  buildVaInstructionsPrompt,
  buildVaInstructionsScaffold,
  CALL_SUMMARY_DRAFT_PROMPT_VERSION,
  CallSummaryDraftShape,
  runDraft,
  VA_INSTRUCTIONS_PROMPT_VERSION,
  VaInstructionsShape,
} from '@studymind/ai'
import {
  addContactCallSummary,
  addContactInternalNote,
  sendContactCallSummary,
  type ChannelResult,
} from '@studymind/core/contact/call-summary'
import {
  addContactDocument,
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  InvalidDocumentError,
  listContactDocuments,
  removeContactDocument,
} from '@studymind/core/contact/documents'
import type { WhatsAppTemplate } from '@studymind/integration-trengo/outbound'

import { buildCallSummarySenders } from '@/lib/board/call-summary-senders'
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

import { logger } from '@studymind/core/logger'
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
        orderBy = [{ createdAt: dir }, { id: 'desc' }]
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
        if (user.role === 'virtual_assistant') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Virtual assistants cannot upload documents',
          })
        }
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
        const user = requireUser(ctx)
        if (user.role === 'virtual_assistant') {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
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

  // Call summary — agent writes a summary against the contact directly (not
  // tied to a board card) and can fan it out to Slack / Trengo / email in
  // one click.
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
          return { id: result.id, occurredAt: result.occurredAt }
        } catch (err) {
          if (err instanceof BusinessError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw err
        }
      }),

    send: auditedProcedure
      .input(
        z.object({
          summaryInteractionId: z.string(),
          // Customer-facing channels only. Slack moved to the internal step
          // (callSummary.logInternal). "trengo" is retained as an optional
          // back-compat alias for the contact's most-recent conversation.
          channels: z.object({
            whatsapp: z.boolean().optional(),
            sms: z.boolean().optional(),
            trengo: z.boolean().optional(),
            email: z.boolean().optional(),
          }),
          // Per-channel body overrides — the wizard composes the email and
          // the text separately. A channel without an override sends the
          // summary Interaction's body.
          channelBodies: z
            .object({
              whatsapp: z.string().trim().min(1).max(8000).optional(),
              sms: z.string().trim().min(1).max(8000).optional(),
              email: z.string().trim().min(1).max(8000).optional(),
              trengo: z.string().trim().min(1).max(8000).optional(),
            })
            .optional(),
          // Subject for a fresh email when the contact has no Gmail thread.
          emailSubject: z.string().trim().min(1).max(200).optional(),
          // Full-Gmail extras: recipient override + Cc/Bcc + send-from address.
          emailTo: z.array(z.string().trim().email()).max(20).optional(),
          emailCc: z.array(z.string().trim().email()).max(20).optional(),
          emailBcc: z.array(z.string().trim().email()).max(20).optional(),
          emailFromAddress: z.string().trim().email().max(254).optional(),
          // Trengo sender line for a NEW WhatsApp/SMS conversation.
          trengoChannelId: z.number().int().positive().optional(),
          // Approved Trengo WhatsApp template — sent via the template session
          // (works outside the 24h window). No PDFs ride this path: the
          // templates already carry the info-pack links.
          whatsappTemplate: z
            .object({
              templateId: z.number().int().positive(),
              templateTitle: z.string().trim().min(1).max(200),
              params: z
                .array(
                  z.object({
                    key: z.string().trim().min(1).max(20),
                    value: z.string().trim().max(500),
                  }),
                )
                .max(20)
                .default([]),
            })
            .optional(),
          emailAttachments: z
            .array(
              z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('contactDocument'), id: z.string() }),
                z.object({ kind: z.literal('uploadedInvoice'), id: z.string() }),
                z.object({ kind: z.literal('callSummaryTemplatePdf'), id: z.string() }),
                z.object({ kind: z.literal('infoPack'), id: z.string() }),
              ]),
            )
            .max(10)
            .optional(),
          // Files the agent picked from their device (base64). Decoded and
          // attached alongside the library files above. ≤8 MB each, ≤10.
          uploadedAttachments: z
            .array(
              z.object({
                filename: z.string().trim().min(1).max(255),
                contentType: z.string().min(1).max(150),
                dataBase64: z.string().min(1),
              }),
            )
            .max(10)
            .optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        const senders = buildCallSummarySenders({
          agentId: user.id,
          requestId: ctx.requestId,
        })
        // Resolve attachments whenever a customer channel that can carry them
        // is selected (WhatsApp / SMS / Trengo / email — Trengo uploads media
        // and attaches it; Gmail attaches inline), not email alone.
        const wantsAttachments = Boolean(
          input.channels.email ||
          input.channels.whatsapp ||
          input.channels.sms ||
          input.channels.trengo,
        )
        const refs = wantsAttachments ? (input.emailAttachments ?? []) : []
        const attachments: Array<{
          filename: string
          contentType: string
          data: Buffer
        }> = []
        for (const ref of refs) {
          if (ref.kind === 'contactDocument') {
            const row = await ctx.db.contactDocument.findUnique({
              where: { id: ref.id },
              select: { fileName: true, contentType: true, data: true },
            })
            if (row)
              attachments.push({
                filename: row.fileName,
                contentType: row.contentType,
                data: row.data,
              })
          } else if (ref.kind === 'uploadedInvoice') {
            const row = await ctx.db.uploadedInvoice.findUnique({
              where: { id: ref.id },
              select: { fileName: true, contentType: true, data: true },
            })
            if (row)
              attachments.push({
                filename: row.fileName,
                contentType: row.contentType,
                data: row.data,
              })
          } else if (ref.kind === 'callSummaryTemplatePdf') {
            const row = await ctx.db.callSummaryTemplate.findUnique({
              where: { id: ref.id },
              select: { pdfFileName: true, pdfContentType: true, pdfData: true },
            })
            if (row && row.pdfData && row.pdfContentType && row.pdfFileName) {
              attachments.push({
                filename: row.pdfFileName,
                contentType: row.pdfContentType,
                data: row.pdfData,
              })
            }
          } else if (ref.kind === 'infoPack') {
            const row = await ctx.db.infoPackDocument.findUnique({
              where: { id: ref.id },
              select: { fileName: true, contentType: true, data: true, archivedAt: true },
            })
            if (row && row.archivedAt == null) {
              attachments.push({
                filename: row.fileName,
                contentType: row.contentType,
                data: row.data,
              })
            }
          }
        }
        // Device uploads — raw files the agent picked from their machine,
        // decoded to Buffers and attached alongside the resolved library files.
        if (wantsAttachments) {
          for (const f of input.uploadedAttachments ?? []) {
            const data = Buffer.from(f.dataBase64, 'base64')
            if (data.byteLength === 0) continue
            if (data.byteLength > 8 * 1024 * 1024) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Attachment "${f.filename}" exceeds the 8 MB limit.`,
              })
            }
            attachments.push({
              filename: f.filename,
              contentType: f.contentType,
              data,
            })
          }
        }
        try {
          const results = await sendContactCallSummary(
            ctx.db,
            {
              summaryInteractionId: input.summaryInteractionId,
              channels: input.channels,
              attachments,
              ...(input.channelBodies ? { channelBodies: input.channelBodies } : {}),
              ...(input.emailSubject ? { emailSubject: input.emailSubject } : {}),
              ...(input.emailTo ? { emailTo: input.emailTo } : {}),
              ...(input.emailCc ? { emailCc: input.emailCc } : {}),
              ...(input.emailBcc ? { emailBcc: input.emailBcc } : {}),
              ...(input.emailFromAddress ? { emailFromAddress: input.emailFromAddress } : {}),
              ...(input.trengoChannelId ? { trengoChannelId: input.trengoChannelId } : {}),
              ...(input.whatsappTemplate ? { whatsappTemplate: input.whatsappTemplate } : {}),
              senders,
            },
            { actorId: user.id, requestId: ctx.requestId },
          )
          ctx.audit.called = true
          return results
        } catch (err) {
          if (err instanceof BusinessError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw err
        }
      }),

    /**
     * The agent's approved Trengo WhatsApp (HSM) templates, surfaced in the
     * wizard's text step "just as they would on Trengo". Graceful: a missing
     * or expired token, or an unsupported workspace, returns `available:false`
     * with a reason instead of erroring — the UI falls back to free text.
     */
    waTemplates: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      try {
        const { listWhatsAppTemplates } = await import('@studymind/integration-trengo/outbound')
        const templates = await listWhatsAppTemplates(user.id, ctx.requestId)
        return { available: true as const, templates }
      } catch (err) {
        const reason =
          err instanceof BusinessError && err.code === 'TOKEN_EXPIRED'
            ? 'Connect your Trengo token in Settings to load WhatsApp templates.'
            : 'Could not load WhatsApp templates from Trengo.'
        return {
          available: false as const,
          reason,
          templates: [] as WhatsAppTemplate[],
        }
      }
    }),

    /** The agent's connected Gmail send-from addresses (primary + send-as) for
     *  the email step's "From" picker. Empty when no mailbox is connected. */
    mailboxes: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      const rows = await ctx.db.gmailMailbox.findMany({
        where: { agentId: user.id, deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: { address: true, isDefault: true },
      })
      return rows.map((r) => ({ address: r.address, isDefault: r.isDefault }))
    }),

    // Two-step flow, step 2: after the customer-facing summary is sent, the
    // agent logs an INTERNAL note (next steps / VA instructions) the customer
    // never sees, optionally posting it to a chosen Slack channel. The
    // follow-up VA task is created separately via task.create.
    logInternal: auditedProcedure
      .input(
        z.object({
          contactId: z.string(),
          note: z.string().trim().min(1).max(8000),
          postToSlack: z.boolean().optional(),
          slackChannelId: z.string().optional(),
          // Drives the Slack VA-team headline ("Call completed — name —
          // phone — email").
          outcome: z.enum(['answered', 'voicemail', 'no_answer']).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        try {
          const created = await addContactInternalNote(
            ctx.db,
            { contactId: input.contactId, note: input.note },
            { actorId: user.id, requestId: ctx.requestId },
          )
          // Core writer audits via writeAuditLogEntry — satisfy the
          // auditedProcedure runtime check.
          ctx.audit.called = true

          let slack: ChannelResult | undefined
          if (input.postToSlack) {
            const senders = buildCallSummarySenders({
              agentId: user.id,
              requestId: ctx.requestId,
            })
            const contact = await ctx.db.contact.findFirst({
              where: { id: input.contactId, deletedAt: null },
              select: { firstName: true, lastName: true },
            })
            const contactName =
              [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() ||
              'this contact'
            slack = senders.slack
              ? await senders.slack({
                  body: input.note,
                  contactName,
                  contactId: input.contactId,
                  slackChannelId: input.slackChannelId,
                  outcome: input.outcome ?? null,
                  // VA-team layout: outcome — name — phone — email headline
                  // plus a "Pending tasks for VA team" section.
                  variant: 'internal_note',
                })
              : { status: 'skipped', detail: 'Slack sender not configured' }
          }

          return { noteInteractionId: created.id, slack }
        } catch (err) {
          if (err instanceof BusinessError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw err
        }
      }),

    // ADR 0039 amendment: every call summary is announced to `#callsummaries`,
    // no exceptions. The wizard calls this on BOTH completion paths (self-send
    // and VA hand-off) so the post is compulsory rather than a per-user choice.
    // The `disposition` makes it awfully clear whether the customer has already
    // been contacted or whether the VA team still needs to act. Best-effort: a
    // Slack failure never loses the CRM record (which is already saved).
    announceToSlack: protectedProcedure
      .input(
        z.object({
          contactId: z.string(),
          summaryInteractionId: z.string().optional(),
          disposition: z.enum(['sent_to_customer', 'va_handoff', 'logged']),
          body: z.string().trim().min(1).max(8000),
          outcome: z.enum(['answered', 'voicemail', 'no_answer']).optional(),
          /** Channels the customer summary actually went out on. */
          sentChannels: z.array(z.string().trim().min(1)).max(8).optional(),
          followUps: z
            .array(
              z.object({
                title: z.string().trim().min(1).max(300),
                dueAt: z.union([z.string(), z.date()]).nullish(),
                assignee: z.string().trim().max(120).nullish(),
              }),
            )
            .max(10)
            .optional(),
          handoffAssignee: z.string().trim().max(120).optional(),
          /** Optional per-send channel override; defaults to the call_summary route. */
          slackChannelId: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        const [contact, author] = await Promise.all([
          ctx.db.contact.findFirst({
            where: { id: input.contactId, deletedAt: null },
            select: { firstName: true, lastName: true },
          }),
          ctx.db.user.findUnique({ where: { id: user.id }, select: { name: true } }),
        ])
        if (!contact) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
        }
        const contactName =
          [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || 'this contact'
        const authorName = author?.name?.trim() || user.email

        const senders = buildCallSummarySenders({ agentId: user.id, requestId: ctx.requestId })
        const slack: ChannelResult = senders.slack
          ? await senders.slack({
              body: input.body,
              contactName,
              contactId: input.contactId,
              slackChannelId: input.slackChannelId,
              outcome: input.outcome ?? null,
              disposition: input.disposition,
              ...(input.sentChannels ? { sentChannels: input.sentChannels } : {}),
              ...(input.followUps
                ? {
                    followUps: input.followUps.map((f) => ({
                      title: f.title,
                      dueAt: f.dueAt ?? null,
                      assignee: f.assignee ?? null,
                    })),
                  }
                : {}),
              ...(input.handoffAssignee ? { handoffAssignee: input.handoffAssignee } : {}),
              authorName,
            })
          : { status: 'skipped', detail: 'Slack sender not configured' }

        return { slack }
      }),

    // Draft a call summary from a recent Aircall transcript using GPT-4o-mini.
    // Returns the draft text; the agent reviews + edits before saving via
    // .add. If no call with a transcript is available, returns null so the UI
    // can show an informative state.
    draftFromCall: protectedProcedure
      .input(
        z.object({
          contactId: z.string(),
          callInteractionId: z.string().optional(),
          /** The agent's current compose text (usually a clicked template) —
           *  when present the AI ENHANCES it with the call's facts instead of
           *  writing a fresh message. */
          baseText: z.string().max(6000).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        const call = await ctx.db.interaction.findFirst({
          where: input.callInteractionId
            ? { id: input.callInteractionId, type: 'call' as const, deletedAt: null }
            : { contactId: input.contactId, type: 'call' as const, deletedAt: null },
          orderBy: { occurredAt: 'desc' },
          select: { id: true, occurredAt: true, payload: true },
        })
        const payload = (call?.payload ?? {}) as {
          transcriptText?: unknown
          outcome?: unknown
        }
        const transcript =
          typeof payload.transcriptText === 'string' ? payload.transcriptText.trim() : ''

        // Context for a customer-facing draft: the contact's name + known
        // interests (subjects) and the acting agent's name for the greeting.
        const [contact, agent] = await Promise.all([
          ctx.db.contact.findFirst({
            where: { id: input.contactId, deletedAt: null },
            select: {
              firstName: true,
              lastName: true,
              email: true,
              subjects: { include: { subject: { select: { name: true } } } },
            },
          }),
          ctx.db.user.findUnique({ where: { id: user.id }, select: { name: true } }),
        ])
        const contactName =
          [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() ||
          contact?.email ||
          'there'
        const interests = (contact?.subjects ?? [])
          .map((s) => s.subject.name)
          .filter((n): n is string => Boolean(n))
        const outcomeRaw = typeof payload.outcome === 'string' ? payload.outcome : undefined
        const outcomeHint =
          outcomeRaw === 'answered' || outcomeRaw === 'voicemail' || outcomeRaw === 'no_answer'
            ? outcomeRaw
            : undefined

        const baseText = input.baseText?.trim() || undefined
        const prompt = buildCallSummaryDraftPrompt({
          transcript,
          contactName,
          callerName: agent?.name ?? null,
          interests,
          outcomeHint,
          baseText,
        })
        // Always hand back usable text: try the model, and on any failure fall
        // back to a deterministic scaffold so the button never "does nothing".
        // BUT be honest about which one happened (`aiUsed`) — silently passing
        // the scaffold off as an AI draft made the button look broken.
        try {
          const result = await runDraft({
            task: 'call_summary_draft',
            promptVersion: CALL_SUMMARY_DRAFT_PROMPT_VERSION,
            system: prompt.system,
            user: prompt.user,
            model: 'gpt-4o-mini',
            temperature: 0.4,
            contentShape: CallSummaryDraftShape,
            contactId: input.contactId,
            ctx: { source: 'contact.callSummary.draftFromCall' },
          })
          return {
            status: 'ok' as const,
            text: result.text,
            aiUsed: true,
            hadTranscript: transcript.length > 0,
            source: (transcript ? 'transcript' : 'scaffold') as 'transcript' | 'scaffold',
            outcomeHint: outcomeHint ?? null,
            callInteractionId: call?.id ?? null,
            callOccurredAt: call?.occurredAt ?? null,
          }
        } catch (err) {
          logger.warn(
            { contactId: input.contactId, err: err instanceof Error ? err.message : String(err) },
            'call_summary_draft.ai_unavailable_fell_back_to_scaffold',
          )
          return {
            status: 'ok' as const,
            // Keep what the agent already wrote in preference to the generic
            // scaffold — wiping their template with boilerplate is worse.
            text: baseText ?? buildCallSummaryScaffold(contactName, agent?.name ?? null, interests),
            aiUsed: false,
            hadTranscript: transcript.length > 0,
            source: 'scaffold' as const,
            outcomeHint: outcomeHint ?? null,
            callInteractionId: call?.id ?? null,
            callOccurredAt: call?.occurredAt ?? null,
          }
        }
      }),

    /**
     * AI-draft the INTERNAL next-step instructions for the team / VA after a
     * call (step 2): "send a ½h trial + all details for the subject", etc.
     * Uses the contact's known subjects + the latest call transcript + the
     * customer summary the agent just wrote. Always returns text (deterministic
     * scaffold on no-AI / error) so the button never no-ops.
     */
    draftInternalNote: protectedProcedure
      .input(
        z.object({
          contactId: z.string(),
          customerSummary: z.string().max(8000).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: {
            firstName: true,
            lastName: true,
            email: true,
            subjects: { include: { subject: { select: { name: true } } } },
          },
        })
        const contactName =
          [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() ||
          contact?.email ||
          'there'
        const interests = (contact?.subjects ?? [])
          .map((s) => s.subject.name)
          .filter((n): n is string => Boolean(n))
        const call = await ctx.db.interaction.findFirst({
          where: { contactId: input.contactId, type: 'call', deletedAt: null },
          orderBy: { occurredAt: 'desc' },
          select: { payload: true },
        })
        const transcriptRaw = (call?.payload as { transcriptText?: unknown } | null)?.transcriptText
        const transcript = typeof transcriptRaw === 'string' ? transcriptRaw.trim() : ''

        const prompt = buildVaInstructionsPrompt({
          contactName,
          interests,
          customerSummary: input.customerSummary,
          transcript: transcript || undefined,
        })
        try {
          const result = await runDraft({
            task: 'call_summary_draft',
            promptVersion: VA_INSTRUCTIONS_PROMPT_VERSION,
            system: prompt.system,
            user: prompt.user,
            model: 'gpt-4o-mini',
            temperature: 0.4,
            contentShape: VaInstructionsShape,
            contactId: input.contactId,
            ctx: { source: 'contact.callSummary.draftInternalNote' },
          })
          return { text: result.text, source: 'ai' as const }
        } catch {
          return { text: buildVaInstructionsScaffold(interests), source: 'scaffold' as const }
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
      const user = requireUser(ctx)
      if (user.role === 'virtual_assistant') {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
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
        const user = requireUser(ctx)
        if (user.role === 'virtual_assistant') {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
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
