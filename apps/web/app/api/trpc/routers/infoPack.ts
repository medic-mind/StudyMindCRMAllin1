// Info pack / brochure document library (Settings → Documents). The PDFs the
// team sends with call-summary emails — information packs, brochures, course
// guides. Stored inline in Postgres (same approach as
// CallSummaryTemplate.pdfData) and served at /api/info-packs/[id]/file.
//
// Mirrors callSummaryTemplate.* (list / pickList / create / update / archive /
// restore) plus replaceFile + delete. Deliberately NOT offered on the Trengo
// WhatsApp path — approved WhatsApp templates already carry the pack links.
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
      message: 'Only Manager or above can manage the document library',
    })
  }
}

/** 8 MB cap matches ContactDocument / CallSummaryTemplate PDFs. */
const MAX_PDF_BYTES = 8 * 1024 * 1024

/** Decode + validate an uploaded PDF (size cap + magic-number sniff). */
function decodePdf(fileName: string, dataBase64: string): Buffer {
  const data = Buffer.from(dataBase64, 'base64')
  if (data.byteLength === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is empty.' })
  }
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `"${fileName}" is over the 8 MB limit.`,
    })
  }
  // Magic-number sniff so callers can't smuggle non-PDFs through the wire.
  if (data.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is not a PDF.' })
  }
  return data
}

const CreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(280).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  fileName: z.string().trim().min(1).max(255),
  // Base64 payload — capped at ~11 MB (8 MB binary * 1.37).
  dataBase64: z.string().min(1).max(12_000_000),
})

const UpdateInput = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(280).nullish(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

const ReplaceFileInput = z.object({
  id: z.string(),
  fileName: z.string().trim().min(1).max(255),
  dataBase64: z.string().min(1).max(12_000_000),
})

export const infoPackRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ includeArchived: z.boolean().default(false) })
        .default({ includeArchived: false }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.infoPackDocument.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          description: true,
          sortOrder: true,
          fileName: true,
          byteSize: true,
          updatedAt: true,
          archivedAt: true,
        },
      })
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        sortOrder: r.sortOrder,
        fileName: r.fileName,
        byteSize: r.byteSize,
        updatedAt: r.updatedAt,
        archived: r.archivedAt != null,
      }))
    }),

  /** Lean selector for the call-summary attachment picker. */
  pickList: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.infoPackDocument.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        fileName: true,
        byteSize: true,
      },
    })
    return rows
  }),

  create: auditedProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const data = decodePdf(input.fileName, input.dataBase64)
    const id = createId()
    try {
      const created = await ctx.db.infoPackDocument.create({
        data: {
          id,
          name: input.name,
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? 100,
          fileName: input.fileName,
          contentType: 'application/pdf',
          byteSize: data.byteLength,
          data,
          createdById: user.id,
          updatedById: user.id,
        },
        select: { id: true, name: true, fileName: true, byteSize: true, sortOrder: true },
      })
      await ctx.audit({
        action: 'info_pack.created',
        target: { type: 'InfoPackDocument', id: created.id },
        after: {
          name: created.name,
          fileName: created.fileName,
          byteSize: created.byteSize,
          sortOrder: created.sortOrder,
        },
      })
      return { id: created.id }
    } catch (err) {
      if (err instanceof Error && /Unique.*name/i.test(err.message)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A document with that name already exists.',
        })
      }
      throw err
    }
  }),

  update: auditedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const before = await ctx.db.infoPackDocument.findUnique({
      where: { id: input.id },
      select: { id: true, name: true, description: true, sortOrder: true },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    try {
      const after = await ctx.db.infoPackDocument.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          description: input.description,
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          updatedById: user.id,
        },
        select: { id: true, name: true, description: true, sortOrder: true },
      })
      await ctx.audit({
        action: 'info_pack.updated',
        target: { type: 'InfoPackDocument', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    } catch (err) {
      if (err instanceof Error && /Unique.*name/i.test(err.message)) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A document with that name already exists.',
        })
      }
      throw err
    }
  }),

  /** Swap the stored PDF without touching the metadata. */
  replaceFile: auditedProcedure.input(ReplaceFileInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const before = await ctx.db.infoPackDocument.findUnique({
      where: { id: input.id },
      select: { id: true, fileName: true, byteSize: true },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    const data = decodePdf(input.fileName, input.dataBase64)
    const after = await ctx.db.infoPackDocument.update({
      where: { id: input.id },
      data: {
        fileName: input.fileName,
        contentType: 'application/pdf',
        byteSize: data.byteLength,
        data,
        updatedById: user.id,
      },
      select: { id: true, fileName: true, byteSize: true },
    })
    await ctx.audit({
      action: 'info_pack.file_replaced',
      target: { type: 'InfoPackDocument', id: after.id },
      before,
      after,
    })
    return { id: after.id, byteSize: after.byteSize }
  }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.infoPackDocument.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, archivedAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.infoPackDocument.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
        select: { id: true, name: true, archivedAt: true },
      })
      await ctx.audit({
        action: 'info_pack.archived',
        target: { type: 'InfoPackDocument', id: after.id },
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
      const before = await ctx.db.infoPackDocument.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, archivedAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.infoPackDocument.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
        select: { id: true, name: true, archivedAt: true },
      })
      await ctx.audit({
        action: 'info_pack.restored',
        target: { type: 'InfoPackDocument', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  /** Permanently remove a document (the bytes too). Archive is the soft path. */
  delete: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.infoPackDocument.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, fileName: true, byteSize: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.infoPackDocument.delete({ where: { id: input.id } })
      await ctx.audit({
        action: 'info_pack.deleted',
        target: { type: 'InfoPackDocument', id: input.id },
        before,
      })
      return { id: input.id }
    }),
})
