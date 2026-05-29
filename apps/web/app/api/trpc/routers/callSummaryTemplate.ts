// Call summary template catalogue. Admin-managed prefill templates that show
// up as chips on the contact page Call Summary panel (UCAT, Medical
// Interview, Dental Interview, etc). Each template carries an optional PDF
// attachment the caller can open mid-call.
//
// Mirrors the shape of `forwarding.rules.*` and `company.*` (list / get /
// create / update / archive / restore / pickList) plus three PDF mutations
// (attachPdf / removePdf) and a lightweight pdfMeta query used by the
// contact page to decide whether to render the "Open PDF" link.
//
// CLAUDE.md §20.1 — Manager+ for writes; all authenticated roles read.

import { createId } from '@paralleldrive/cuid2'
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
      message: 'Only Manager or above can manage call summary templates',
    })
  }
}

/** 8 MB cap matches ContactDocument. PDFs above this should live in S3. */
const MAX_PDF_BYTES = 8 * 1024 * 1024

const CreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(280).optional(),
  body: z.string().trim().min(1).max(10_000),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

const UpdateInput = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(280).nullish(),
  body: z.string().trim().min(1).max(10_000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

const AttachPdfInput = z.object({
  id: z.string(),
  fileName: z.string().trim().min(1).max(255),
  // Base64 payload — capped at ~11 MB (8 MB binary * 1.37). Mirrors the
  // ContactDocument upload contract.
  dataBase64: z.string().min(1).max(12_000_000),
})

export const callSummaryTemplateRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ includeArchived: z.boolean().default(false) })
        .default({ includeArchived: false }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.callSummaryTemplate.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          body: true,
          sortOrder: true,
          archivedAt: true,
          pdfFileName: true,
          pdfContentType: true,
          pdfByteSize: true,
        },
      })
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        body: r.body,
        sortOrder: r.sortOrder,
        archived: r.archivedAt != null,
        hasPdf: r.pdfByteSize != null && r.pdfByteSize > 0,
        pdfFileName: r.pdfFileName,
        pdfByteSize: r.pdfByteSize,
      }))
    }),

  /** Lean selector used by the contact page Call Summary panel. */
  pickList: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.callSummaryTemplate.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        body: true,
        pdfByteSize: true,
        pdfFileName: true,
      },
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      body: r.body,
      hasPdf: r.pdfByteSize != null && r.pdfByteSize > 0,
      pdfFileName: r.pdfFileName,
    }))
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.callSummaryTemplate.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          description: true,
          body: true,
          sortOrder: true,
          archivedAt: true,
          pdfFileName: true,
          pdfContentType: true,
          pdfByteSize: true,
        },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        body: row.body,
        sortOrder: row.sortOrder,
        archived: row.archivedAt != null,
        hasPdf: row.pdfByteSize != null && row.pdfByteSize > 0,
        pdfFileName: row.pdfFileName,
        pdfByteSize: row.pdfByteSize,
      }
    }),

  create: auditedProcedure
    .input(CreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const id = createId()
      try {
        const created = await ctx.db.callSummaryTemplate.create({
          data: {
            id,
            name: input.name,
            description: input.description ?? null,
            body: input.body,
            sortOrder: input.sortOrder ?? 100,
            createdById: user.id,
            updatedById: user.id,
          },
        })
        await ctx.audit({
          action: 'call_summary_template.created',
          target: { type: 'CallSummaryTemplate', id: created.id },
          after: {
            name: created.name,
            sortOrder: created.sortOrder,
          },
        })
        return { id: created.id }
      } catch (err) {
        if (err instanceof Error && /Unique.*name/i.test(err.message)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A template with that name already exists.',
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
      const before = await ctx.db.callSummaryTemplate.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          description: true,
          sortOrder: true,
        },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      try {
        const after = await ctx.db.callSummaryTemplate.update({
          where: { id: input.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            description: input.description,
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
            updatedById: user.id,
          },
          select: { id: true, name: true, description: true, sortOrder: true },
        })
        await ctx.audit({
          action: 'call_summary_template.updated',
          target: { type: 'CallSummaryTemplate', id: after.id },
          before,
          after,
        })
        return { id: after.id }
      } catch (err) {
        if (err instanceof Error && /Unique.*name/i.test(err.message)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A template with that name already exists.',
          })
        }
        throw err
      }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.callSummaryTemplate.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, archivedAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.callSummaryTemplate.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
        select: { id: true, name: true, archivedAt: true },
      })
      await ctx.audit({
        action: 'call_summary_template.archived',
        target: { type: 'CallSummaryTemplate', id: after.id },
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
      const before = await ctx.db.callSummaryTemplate.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, archivedAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.callSummaryTemplate.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
        select: { id: true, name: true, archivedAt: true },
      })
      await ctx.audit({
        action: 'call_summary_template.restored',
        target: { type: 'CallSummaryTemplate', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  /** Attach (or replace) the PDF on a template. Only PDFs are accepted. */
  attachPdf: auditedProcedure
    .input(AttachPdfInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const existing = await ctx.db.callSummaryTemplate.findUnique({
        where: { id: input.id },
        select: { id: true, pdfFileName: true, pdfByteSize: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })

      const data = Buffer.from(input.dataBase64, 'base64')
      if (data.byteLength === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is empty.' })
      }
      if (data.byteLength > MAX_PDF_BYTES) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'PDF must be 8 MB or smaller.' })
      }
      // Magic-number sniff so callers can't smuggle non-PDFs through the
      // base64 wire. PDFs start with "%PDF-".
      const head = data.subarray(0, 5).toString('ascii')
      if (head !== '%PDF-') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is not a PDF.' })
      }

      const updated = await ctx.db.callSummaryTemplate.update({
        where: { id: input.id },
        data: {
          pdfFileName: input.fileName,
          pdfContentType: 'application/pdf',
          pdfByteSize: data.byteLength,
          pdfData: data,
          updatedById: user.id,
        },
        select: { id: true, pdfFileName: true, pdfByteSize: true },
      })
      await ctx.audit({
        action: 'call_summary_template.pdf_attached',
        target: { type: 'CallSummaryTemplate', id: updated.id },
        before: {
          pdfFileName: existing.pdfFileName,
          pdfByteSize: existing.pdfByteSize,
        },
        after: {
          pdfFileName: updated.pdfFileName,
          pdfByteSize: updated.pdfByteSize,
        },
      })
      return { id: updated.id, byteSize: updated.pdfByteSize }
    }),

  removePdf: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.callSummaryTemplate.findUnique({
        where: { id: input.id },
        select: { id: true, pdfFileName: true, pdfByteSize: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.callSummaryTemplate.update({
        where: { id: input.id },
        data: {
          pdfFileName: null,
          pdfContentType: null,
          pdfByteSize: null,
          pdfData: null,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'call_summary_template.pdf_removed',
        target: { type: 'CallSummaryTemplate', id: input.id },
        before: {
          pdfFileName: before.pdfFileName,
          pdfByteSize: before.pdfByteSize,
        },
      })
      return { id: input.id }
    }),
})
