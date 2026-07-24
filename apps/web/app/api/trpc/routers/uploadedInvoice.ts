// Uploaded invoices — manually attached invoice files (PDFs / images / Excel)
// scoped to a BusinessAccount (B2B / Schools / Partners), a Family (normal
// customer), or a Contact (lead / one-off). Different from the finance-
// mirrored Invoice table; this is the canonical place agents drop
// invoice paperwork against any of the three owners.
//
// Cross-app connectivity with b2b.studymind.co.uk lands in a follow-up PR;
// today this is the upload + browse + audit surface. The file lives inline
// in Postgres (same trade-off as ContactDocument + CallSummaryTemplate
// per CLAUDE.md §4).
//
// CLAUDE.md §20.1 — Manager+ uploads / updates / deletes; Sales Executive
// can upload too (operational chore); Virtual Assistant is read-only.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { UploadedInvoiceStatus } from '@prisma/client'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const UPLOAD_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const DELETE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function assertCanUpload(role: UserRole): void {
  if (!UPLOAD_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Virtual Assistants cannot upload invoices',
    })
  }
}

function assertCanDelete(role: UserRole): void {
  if (!DELETE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager or above can delete invoices',
    })
  }
}

/** 8 MB cap matches ContactDocument. */
const MAX_BYTES = 8 * 1024 * 1024

const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

const StatusEnum = z.nativeEnum(UploadedInvoiceStatus)

const OwnerInput = z
  .object({
    businessAccountId: z.string().optional(),
    contactId: z.string().optional(),
    familyId: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const setCount =
      (val.businessAccountId ? 1 : 0) +
      (val.contactId ? 1 : 0) +
      (val.familyId ? 1 : 0)
    if (setCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of businessAccountId / contactId / familyId is required',
      })
    }
  })

const CreateInput = z
  .object({
    invoiceNumber: z.string().trim().max(80).optional(),
    amountMinor: z.number().int().min(0).max(2_000_000_000).optional(),
    currency: z.string().trim().min(3).max(3).default('GBP'),
    issuedAt: z.date().optional(),
    dueAt: z.date().optional(),
    status: StatusEnum.optional(),
    notes: z.string().trim().max(2000).optional(),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    // Base64 payload — capped to ~11 MB (8 MB binary * 1.37).
    dataBase64: z.string().min(1).max(12_000_000),
  })
  .merge(
    z.object({
      businessAccountId: z.string().optional(),
      contactId: z.string().optional(),
      familyId: z.string().optional(),
    }),
  )
  .superRefine((val, ctx) => {
    const setCount =
      (val.businessAccountId ? 1 : 0) +
      (val.contactId ? 1 : 0) +
      (val.familyId ? 1 : 0)
    if (setCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of businessAccountId / contactId / familyId is required',
      })
    }
  })

const UpdateInput = z.object({
  id: z.string(),
  invoiceNumber: z.string().trim().max(80).nullish(),
  amountMinor: z.number().int().min(0).max(2_000_000_000).nullish(),
  currency: z.string().trim().min(3).max(3).optional(),
  issuedAt: z.date().nullish(),
  dueAt: z.date().nullish(),
  status: StatusEnum.optional(),
  notes: z.string().trim().max(2000).nullish(),
})

function summary(row: {
  id: string
  invoiceNumber: string | null
  amountMinor: number | null
  currency: string
  issuedAt: Date | null
  dueAt: Date | null
  status: UploadedInvoiceStatus
  notes: string | null
  fileName: string
  contentType: string
  byteSize: number
  createdAt: Date
  archivedAt: Date | null
  createdById: string | null
}) {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    amountMinor: row.amountMinor,
    currency: row.currency,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    status: row.status,
    notes: row.notes,
    fileName: row.fileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    archived: row.archivedAt != null,
    createdById: row.createdById,
  }
}

export const uploadedInvoiceRouter = router({
  /** List invoices for one owner (exactly one of the three filters set). */
  list: protectedProcedure
    .input(OwnerInput.and(z.object({ includeArchived: z.boolean().default(false) })))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.uploadedInvoice.findMany({
        where: {
          ...(input.businessAccountId ? { businessAccountId: input.businessAccountId } : {}),
          ...(input.contactId ? { contactId: input.contactId } : {}),
          ...(input.familyId ? { familyId: input.familyId } : {}),
          ...(input.includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ archivedAt: 'asc' }, { issuedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          invoiceNumber: true,
          amountMinor: true,
          currency: true,
          issuedAt: true,
          dueAt: true,
          status: true,
          notes: true,
          fileName: true,
          contentType: true,
          byteSize: true,
          createdAt: true,
          archivedAt: true,
          createdById: true,
        },
      })
      return rows.map(summary)
    }),

  create: auditedProcedure
    .input(CreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanUpload(user.role)

      // Owner exists?
      if (input.businessAccountId) {
        const a = await ctx.db.businessAccount.findUnique({
          where: { id: input.businessAccountId },
          select: { id: true },
        })
        if (!a) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
      } else if (input.contactId) {
        const c = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true },
        })
        if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      } else if (input.familyId) {
        const f = await ctx.db.family.findFirst({
          where: { id: input.familyId, deletedAt: null },
          select: { id: true },
        })
        if (!f) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found' })
      }

      const data = Buffer.from(input.dataBase64, 'base64')
      if (data.byteLength === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is empty.' })
      }
      if (data.byteLength > MAX_BYTES) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'File must be 8 MB or smaller.',
        })
      }

      const id = createId()
      const row = await ctx.db.uploadedInvoice.create({
        data: {
          id,
          businessAccountId: input.businessAccountId ?? null,
          contactId: input.contactId ?? null,
          familyId: input.familyId ?? null,
          invoiceNumber: input.invoiceNumber ?? null,
          amountMinor: input.amountMinor ?? null,
          currency: input.currency,
          issuedAt: input.issuedAt ?? null,
          dueAt: input.dueAt ?? null,
          status: input.status ?? 'draft',
          notes: input.notes ?? null,
          fileName: input.fileName,
          contentType: input.contentType,
          byteSize: data.byteLength,
          data,
          createdById: user.id,
          updatedById: user.id,
        },
        select: {
          id: true,
          invoiceNumber: true,
          amountMinor: true,
          currency: true,
          issuedAt: true,
          dueAt: true,
          status: true,
          notes: true,
          fileName: true,
          contentType: true,
          byteSize: true,
          createdAt: true,
          archivedAt: true,
          createdById: true,
          businessAccountId: true,
          contactId: true,
          familyId: true,
        },
      })

      const target = row.businessAccountId
        ? ({ type: 'BusinessAccount', id: row.businessAccountId } as const)
        : row.contactId
          ? ({ type: 'Contact', id: row.contactId } as const)
          : ({ type: 'Family', id: row.familyId! } as const)

      await ctx.audit({
        action: 'uploaded_invoice.created',
        target,
        after: {
          uploadedInvoiceId: row.id,
          invoiceNumber: row.invoiceNumber,
          amountMinor: row.amountMinor,
          fileName: row.fileName,
          byteSize: row.byteSize,
          status: row.status,
        },
      })
      return summary(row)
    }),

  update: auditedProcedure
    .input(UpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanUpload(user.role)
      const before = await ctx.db.uploadedInvoice.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          businessAccountId: true,
          contactId: true,
          familyId: true,
          invoiceNumber: true,
          amountMinor: true,
          currency: true,
          status: true,
          notes: true,
        },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.uploadedInvoice.update({
        where: { id: input.id },
        data: {
          invoiceNumber: input.invoiceNumber,
          amountMinor: input.amountMinor,
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          issuedAt: input.issuedAt,
          dueAt: input.dueAt,
          ...(input.status !== undefined ? { status: input.status } : {}),
          notes: input.notes,
          updatedById: user.id,
        },
        select: {
          id: true,
          invoiceNumber: true,
          amountMinor: true,
          currency: true,
          issuedAt: true,
          dueAt: true,
          status: true,
          notes: true,
          fileName: true,
          contentType: true,
          byteSize: true,
          createdAt: true,
          archivedAt: true,
          createdById: true,
        },
      })

      const target = before.businessAccountId
        ? ({ type: 'BusinessAccount', id: before.businessAccountId } as const)
        : before.contactId
          ? ({ type: 'Contact', id: before.contactId } as const)
          : ({ type: 'Family', id: before.familyId! } as const)

      await ctx.audit({
        action: 'uploaded_invoice.updated',
        target,
        before: {
          invoiceNumber: before.invoiceNumber,
          amountMinor: before.amountMinor,
          status: before.status,
        },
        after: {
          uploadedInvoiceId: after.id,
          invoiceNumber: after.invoiceNumber,
          amountMinor: after.amountMinor,
          status: after.status,
        },
      })
      return summary(after)
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanUpload(user.role)
      const before = await ctx.db.uploadedInvoice.findUnique({
        where: { id: input.id },
        select: { id: true, businessAccountId: true, contactId: true, familyId: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.uploadedInvoice.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      const target = before.businessAccountId
        ? ({ type: 'BusinessAccount', id: before.businessAccountId } as const)
        : before.contactId
          ? ({ type: 'Contact', id: before.contactId } as const)
          : ({ type: 'Family', id: before.familyId! } as const)
      await ctx.audit({
        action: 'uploaded_invoice.archived',
        target,
        before: { uploadedInvoiceId: input.id },
      })
      return { id: input.id }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanUpload(user.role)
      const before = await ctx.db.uploadedInvoice.findUnique({
        where: { id: input.id },
        select: { id: true, businessAccountId: true, contactId: true, familyId: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.uploadedInvoice.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      const target = before.businessAccountId
        ? ({ type: 'BusinessAccount', id: before.businessAccountId } as const)
        : before.contactId
          ? ({ type: 'Contact', id: before.contactId } as const)
          : ({ type: 'Family', id: before.familyId! } as const)
      await ctx.audit({
        action: 'uploaded_invoice.restored',
        target,
        after: { uploadedInvoiceId: input.id },
      })
      return { id: input.id }
    }),

  delete: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanDelete(user.role)
      const before = await ctx.db.uploadedInvoice.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          businessAccountId: true,
          contactId: true,
          familyId: true,
          fileName: true,
          byteSize: true,
        },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.uploadedInvoice.delete({ where: { id: input.id } })
      const target = before.businessAccountId
        ? ({ type: 'BusinessAccount', id: before.businessAccountId } as const)
        : before.contactId
          ? ({ type: 'Contact', id: before.contactId } as const)
          : ({ type: 'Family', id: before.familyId! } as const)
      await ctx.audit({
        action: 'uploaded_invoice.deleted',
        target,
        before: {
          uploadedInvoiceId: input.id,
          fileName: before.fileName,
          byteSize: before.byteSize,
        },
      })
      return { id: input.id }
    }),
})
