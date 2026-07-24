// Direct Debit recovery-comms templates (ADR 0038, Phase 3).
//
// Staff-authored reminder / legal-escalation copy used to draft a
// human-confirmed send from a recovery case. We ship NO copy — bodies start
// empty and Managers write them (legal wording is theirs). `list`/`pickList`
// are finance-role reads; create/update/archive/restore are Manager+.
// CLAUDE.md §20, §27, §3 (nothing sends here).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { protectedProcedure, requireUser, router, type UserRole } from '@/lib/trpc/builders'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])
const FINANCE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const KINDS = ['reminder', 'legal_escalation', 'other'] as const
const CHANNELS = ['email', 'trengo', 'sms'] as const
const MAX_PDF_BYTES = 8 * 1024 * 1024

function assertManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Manager and above only' })
  }
}
function assertFinance(role: UserRole): void {
  if (!FINANCE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Finance roles only' })
  }
}

const UpsertInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS),
  channel: z.enum(CHANNELS),
  subject: z.string().trim().max(200).nullish(),
  body: z.string().max(10_000),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
})

const SELECT = {
  id: true,
  name: true,
  kind: true,
  channel: true,
  subject: true,
  body: true,
  sortOrder: true,
  archivedAt: true,
  // PDF metadata only (the "letter before action" the team attaches to email
  // escalations, ADR 0045 amendment) — never the bytes over the wire.
  pdfFileName: true,
  pdfByteSize: true,
} as const

export const ddRecoveryTemplateRouter = router({
  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      assertFinance(requireUser(ctx).role)
      return ctx.db.ddRecoveryTemplate.findMany({
        where: { deletedAt: null, ...(input?.includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        take: 200,
        select: SELECT,
      })
    }),

  /** Active templates for the case send picker, optionally by channel. */
  pickList: protectedProcedure
    .input(z.object({ channel: z.enum(CHANNELS).nullish() }).optional())
    .query(async ({ ctx, input }) => {
      assertFinance(requireUser(ctx).role)
      return ctx.db.ddRecoveryTemplate.findMany({
        where: {
          deletedAt: null,
          archivedAt: null,
          ...(input?.channel ? { channel: input.channel } : {}),
        },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        take: 200,
        select: SELECT,
      })
    }),

  create: protectedProcedure.input(UpsertInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertManage(user.role)
    const row = await ctx.db.ddRecoveryTemplate.create({
      data: {
        id: createId(),
        name: input.name,
        kind: input.kind,
        channel: input.channel,
        subject: input.subject ?? null,
        body: input.body,
        sortOrder: input.sortOrder ?? 0,
        createdById: user.id,
        updatedById: user.id,
      },
      select: SELECT,
    })
    await ctx.audit({
      action: 'dd_recovery_template.created',
      target: { type: 'DdRecoveryTemplate', id: row.id },
      after: { name: row.name, kind: row.kind, channel: row.channel },
    })
    return row
  }),

  update: protectedProcedure
    .input(UpsertInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      const row = await ctx.db.ddRecoveryTemplate.update({
        where: { id: input.id },
        data: {
          name: input.name,
          kind: input.kind,
          channel: input.channel,
          subject: input.subject ?? null,
          body: input.body,
          sortOrder: input.sortOrder ?? 0,
          updatedById: user.id,
        },
        select: SELECT,
      })
      await ctx.audit({
        action: 'dd_recovery_template.updated',
        target: { type: 'DdRecoveryTemplate', id: row.id },
        after: { name: row.name, kind: row.kind, channel: row.channel },
      })
      return row
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      await ctx.db.ddRecoveryTemplate.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'dd_recovery_template.archived',
        target: { type: 'DdRecoveryTemplate', id: input.id },
      })
      return { ok: true }
    }),

  restore: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      await ctx.db.ddRecoveryTemplate.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'dd_recovery_template.restored',
        target: { type: 'DdRecoveryTemplate', id: input.id },
      })
      return { ok: true }
    }),

  /** Attach the "letter before action" / escalation PDF to a template (ADR 0045
   *  amendment). Email sends attach it automatically; SMS ignores it. Stored
   *  inline, magic-number sniffed, 8 MB cap — same as CallSummaryTemplate. */
  attachPdf: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        fileName: z.string().trim().min(1).max(200),
        dataBase64: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      const existing = await ctx.db.ddRecoveryTemplate.findUnique({
        where: { id: input.id },
        select: { id: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      const data = Buffer.from(input.dataBase64, 'base64')
      if (data.byteLength === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is empty.' })
      }
      if (data.byteLength > MAX_PDF_BYTES) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'PDF must be 8 MB or smaller.' })
      }
      if (data.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'File is not a PDF.' })
      }
      await ctx.db.ddRecoveryTemplate.update({
        where: { id: input.id },
        data: {
          pdfFileName: input.fileName,
          pdfContentType: 'application/pdf',
          pdfByteSize: data.byteLength,
          pdfData: data,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'dd_recovery_template.pdf_attached',
        target: { type: 'DdRecoveryTemplate', id: input.id },
        after: { pdfFileName: input.fileName, pdfByteSize: data.byteLength },
      })
      return { id: input.id, byteSize: data.byteLength }
    }),

  removePdf: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      const before = await ctx.db.ddRecoveryTemplate.findUnique({
        where: { id: input.id },
        select: { id: true, pdfFileName: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.ddRecoveryTemplate.update({
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
        action: 'dd_recovery_template.pdf_removed',
        target: { type: 'DdRecoveryTemplate', id: input.id },
        before: { pdfFileName: before.pdfFileName },
      })
      return { ok: true }
    }),
})
