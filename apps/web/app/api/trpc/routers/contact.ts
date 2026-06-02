// Contact router. See CLAUDE.md Sections 27, 20.
// All mutations are audited (auditedProcedure runtime-checks ctx.audit was called).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { BusinessError } from '@studymind/core/errors'

import {
  buildCallSummaryDraftPrompt,
  CALL_SUMMARY_DRAFT_PROMPT_VERSION,
  CallSummaryDraftShape,
  runDraft,
} from '@studymind/ai'
import {
  addContactCallSummary,
  sendContactCallSummary,
} from '@studymind/core/contact/call-summary'
import {
  addContactDocument,
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  InvalidDocumentError,
  listContactDocuments,
  removeContactDocument,
} from '@studymind/core/contact/documents'

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

import { loadContactCommsCounts } from '@studymind/core/stats'

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
  /** Filter by Company.id (m2m — matches contacts tagged with this brand). */
  companyId: z.string().nullish(),
  /** Filter by Subject.id (m2m). */
  subjectId: z.string().nullish(),
  /** Filter by contact kind (parent / student / tutor / other). */
  kind: z.enum(['parent', 'student', 'tutor', 'other']).optional(),
  /** Filter by booking lifecycle (CLAUDE.md §15). */
  bookingStatus: z
    .enum(['lead', 'registered_no_hours', 'registered_with_hours'])
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
  list: protectedProcedure
    .input(ListInput)
    .query(async ({ ctx, input }) => {
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

      const rows = await ctx.db.contact.findMany({
        where: {
          deletedAt: null,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.bookingStatus ? { bookingStatus: input.bookingStatus } : {}),
          ...(input.hasFamily !== undefined
            ? input.hasFamily
              ? { familyMembers: { some: {} } }
              : { familyMembers: { none: {} } }
            : {}),
          ...(input.companyId
            ? { companies: { some: { companyId: input.companyId } } }
            : {}),
          ...(input.subjectId
            ? { subjects: { some: { subjectId: input.subjectId } } }
            : {}),
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
                ],
              }
            : {}),
          ...(input.cursor && input.sortBy === 'createdAt'
            ? input.sortDir === 'desc'
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
              : {
                  OR: [
                    { createdAt: { gt: input.cursor.createdAt } },
                    {
                      AND: [
                        { createdAt: input.cursor.createdAt },
                        { id: { gt: input.cursor.id } },
                      ],
                    },
                  ],
                }
            : {}),
        },
        orderBy,
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
          companies: {
            include: {
              company: { select: { id: true, name: true, slug: true, color: true } },
            },
          },
          labels: {
            include: { label: { select: { id: true, name: true, color: true } } },
          },
          bookingProfile: { select: { hoursRemaining: true, nextHoursExpiryAt: true } },
        },
      })

      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      // One batched groupBy for the whole page's call/text/email counts.
      const counts = await loadContactCommsCounts(
        ctx.db,
        sliced.map((r) => r.id),
      )
      const items: ContactSummary[] = sliced.map((r) =>
        toContactSummary(r, counts.get(r.id)),
      )
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
          channels: z.object({
            slack: z.boolean().optional(),
            trengo: z.boolean().optional(),
            email: z.boolean().optional(),
          }),
          slackChannelId: z.string().optional(),
          emailAttachments: z
            .array(
              z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('contactDocument'), id: z.string() }),
                z.object({ kind: z.literal('uploadedInvoice'), id: z.string() }),
                z.object({ kind: z.literal('callSummaryTemplatePdf'), id: z.string() }),
              ]),
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
        const refs = input.channels.email ? (input.emailAttachments ?? []) : []
        const emailAttachments: Array<{
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
            if (row) emailAttachments.push({
              filename: row.fileName,
              contentType: row.contentType,
              data: row.data,
            })
          } else if (ref.kind === 'uploadedInvoice') {
            const row = await ctx.db.uploadedInvoice.findUnique({
              where: { id: ref.id },
              select: { fileName: true, contentType: true, data: true },
            })
            if (row) emailAttachments.push({
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
              emailAttachments.push({
                filename: row.pdfFileName,
                contentType: row.pdfContentType,
                data: row.pdfData,
              })
            }
          }
        }
        try {
          const results = await sendContactCallSummary(
            ctx.db,
            {
              summaryInteractionId: input.summaryInteractionId,
              channels: input.channels,
              slackChannelId: input.slackChannelId,
              emailAttachments,
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

    // Draft a call summary from a recent Aircall transcript using GPT-4o-mini.
    // Returns the draft text; the agent reviews + edits before saving via
    // .add. If no call with a transcript is available, returns null so the UI
    // can show an informative state.
    draftFromCall: protectedProcedure
      .input(
        z.object({
          contactId: z.string(),
          callInteractionId: z.string().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const call = await ctx.db.interaction.findFirst({
          where: input.callInteractionId
            ? { id: input.callInteractionId, type: 'call' as const, deletedAt: null }
            : { contactId: input.contactId, type: 'call' as const, deletedAt: null },
          orderBy: { occurredAt: 'desc' },
          select: { id: true, occurredAt: true, payload: true },
        })
        if (!call) {
          return { status: 'no_call' as const }
        }
        const payload = (call.payload ?? {}) as {
          transcriptText?: unknown
          outcome?: unknown
        }
        const transcript =
          typeof payload.transcriptText === 'string' ? payload.transcriptText.trim() : ''
        if (!transcript) {
          return {
            status: 'no_transcript' as const,
            callInteractionId: call.id,
            callOccurredAt: call.occurredAt,
          }
        }

        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
        const contactName =
          [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() ||
          contact?.email ||
          'this contact'
        const outcomeRaw = typeof payload.outcome === 'string' ? payload.outcome : undefined
        const outcomeHint =
          outcomeRaw === 'answered' || outcomeRaw === 'voicemail' || outcomeRaw === 'no_answer'
            ? outcomeRaw
            : undefined

        const prompt = buildCallSummaryDraftPrompt({
          transcript,
          contactName,
          outcomeHint,
        })
        try {
          const result = await runDraft({
            task: 'call_summary_draft',
            promptVersion: CALL_SUMMARY_DRAFT_PROMPT_VERSION,
            system: prompt.system,
            user: prompt.user,
            model: 'gpt-4o-mini',
            temperature: 0.2,
            contentShape: CallSummaryDraftShape,
            contactId: input.contactId,
            ctx: { source: 'contact.callSummary.draftFromCall' },
          })
          return {
            status: 'ok' as const,
            text: result.text,
            outcomeHint: outcomeHint ?? null,
            callInteractionId: call.id,
            callOccurredAt: call.occurredAt,
          }
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
      if (
        user.role !== 'ceo' &&
        user.role !== 'senior_manager' &&
        user.role !== 'manager'
      ) {
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
