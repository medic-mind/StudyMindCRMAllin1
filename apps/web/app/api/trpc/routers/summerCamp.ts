// Summer Camp router. Read-only feeds for the live, view-only "Summer Camps"
// surface (roster + fill + weekly timetables) the sales team uses. CLAUDE.md
// §27. All staff may read; nothing here mutates, so no audit context.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  instalmentState,
  isOnInstalments,
  parseInstalmentCsv,
  remainingMinor,
  summariseInstalments,
} from '@studymind/core/camp'
import { createClientFromConfig } from '@studymind/integration-summer-camp/client'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

// Importing all current bookings creates Contacts — gate to the admin tier,
// matching the other backfill triggers (ADR 0017 / conversation-head backfill).
const BACKFILL_ROLES: ReadonlySet<SessionUser['role']> = new Set(['ceo', 'senior_manager'])

// Instalment money writes (import / edit / delete a booking) — finance-grade,
// so Manager and above. Reads are open to all staff.
const INSTALMENT_WRITE_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])
function assertCanWriteInstalments(role: SessionUser['role']): void {
  if (!INSTALMENT_WRITE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager or above can change camp instalment records',
    })
  }
}

export const summerCampRouter = router({
  // Whether the camp app feeds are configured, so the UI can render a clear
  // "not connected" state instead of an error.
  status: protectedProcedure.query(({ ctx }) => {
    requireUser(ctx)
    return { connected: createClientFromConfig() !== null }
  }),

  camps: protectedProcedure
    .input(z.object({ year: z.number().int().min(2000).max(2100).optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      const client = createClientFromConfig()
      if (!client) return { connected: false as const, feed: null }
      try {
        const feed = await client.getCamps(input?.year)
        return { connected: true as const, feed }
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'summer camp feed unavailable',
        })
      }
    }),

  timetable: protectedProcedure
    .input(z.object({ campId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      const client = createClientFromConfig()
      if (!client) return { connected: false as const, feed: null }
      try {
        const feed = await client.getTimetable(input?.campId ?? null)
        return { connected: true as const, feed }
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'summer camp timetable unavailable',
        })
      }
    }),

  // Import ALL current camp bookings into the CRM (one-shot, background).
  // Fires the self-rescheduling Inngest backfill; the recurring sync then
  // keeps the CRM in step. CEO + Senior Manager only.
  backfill: auditedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!BACKFILL_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
    if (!createClientFromConfig()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Summer Camp app is not connected.' })
    }
    const { inngest } = await import('@studymind/jobs')
    const jobId = `scbf_${Date.now().toString(36)}_${user.id.slice(-6)}`
    await inngest.send({ name: 'summer-camp/backfill-bookings.requested', data: { jobId } })
    await ctx.audit({
      action: 'summer_camp.backfill_requested',
      target: { type: 'System', id: jobId },
      after: { initiatedBy: user.id },
    })
    return { jobId }
  }),

  // ---------------------------------------------------------------------------
  // Instalment tracking (CSV-imported camp bookings). Lives in the Summer Camp
  // section only. Money in pence; remaining balance is derived, never stored.
  // ---------------------------------------------------------------------------
  instalments: router({
    /** Bookings + derived remaining balance + headline totals, filterable. */
    list: protectedProcedure
      .input(
        z
          .object({
            cohort: z.enum(['all', 'instalments', 'outstanding']).default('all'),
            paymentType: z.string().trim().min(1).optional(),
            status: z.string().trim().min(1).optional(),
            search: z.string().trim().max(120).optional(),
          })
          .default({ cohort: 'all' }),
      )
      .query(async ({ ctx, input }) => {
        requireUser(ctx)
        const where: Prisma.SummerCampBookingWhereInput = { deletedAt: null }
        if (input.paymentType) where.paymentType = input.paymentType
        if (input.status) where.status = input.status
        if (input.search) {
          const q = input.search
          where.OR = [
            { studentName: { contains: q, mode: 'insensitive' } },
            { studentEmail: { contains: q, mode: 'insensitive' } },
            { guardianName: { contains: q, mode: 'insensitive' } },
            { subject: { contains: q, mode: 'insensitive' } },
            { agent: { contains: q, mode: 'insensitive' } },
          ]
        }
        const rows = await ctx.db.summerCampBooking.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          take: 5000,
        })

        const mapped = rows.map((r) => ({
          id: r.id,
          studentName: r.studentName,
          studentEmail: r.studentEmail,
          guardianName: r.guardianName,
          subject: r.subject,
          bookingType: r.bookingType,
          paymentType: r.paymentType,
          weeks: r.weeks,
          status: r.status,
          agent: r.agent,
          notes: r.notes,
          totalDueMinor: r.totalDueMinor,
          depositPaidMinor: r.depositPaidMinor,
          remainingMinor: remainingMinor(r.totalDueMinor, r.depositPaidMinor),
          state: instalmentState(r.totalDueMinor, r.depositPaidMinor),
          onInstalments: isOnInstalments(r),
        }))

        const cohort =
          input.cohort === 'instalments'
            ? mapped.filter((m) => m.onInstalments)
            : input.cohort === 'outstanding'
              ? mapped.filter((m) => m.remainingMinor > 0)
              : mapped

        // Facets from the FULL non-deleted set so the dropdowns are stable.
        const all = await ctx.db.summerCampBooking.findMany({
          where: { deletedAt: null },
          select: { paymentType: true, status: true },
          take: 5000,
        })
        const paymentTypes = [
          ...new Set(all.map((r) => r.paymentType).filter((x): x is string => !!x)),
        ].sort()
        const statuses = [
          ...new Set(all.map((r) => r.status).filter((x): x is string => !!x)),
        ].sort()

        return {
          items: cohort,
          summary: summariseInstalments(cohort),
          facets: { paymentTypes, statuses },
        }
      }),

    /** Import / re-import the booking CSV. Idempotent on the dedupe key, so the
     *  latest sheet updates existing rows rather than duplicating. Manager+. */
    importCsv: auditedProcedure
      .input(z.object({ csv: z.string().min(1).max(5_000_000) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanWriteInstalments(user.role)
        const parsed = parseInstalmentCsv(input.csv)
        if (parsed.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'No bookings found — check the CSV has the expected header row (Name of Student, Payment Type, Amount Paid (£), …).',
          })
        }
        // De-dupe within the file (last row wins for a key).
        const byKey = new Map(parsed.map((b) => [b.dedupeKey, b]))
        const existing = await ctx.db.summerCampBooking.findMany({
          where: { dedupeKey: { in: [...byKey.keys()] } },
          select: { dedupeKey: true },
        })
        const existingKeys = new Set(existing.map((e) => e.dedupeKey))

        let created = 0
        let updated = 0
        for (const b of byKey.values()) {
          const data = {
            source: 'csv_import',
            externalRef: b.externalRef,
            bookingType: b.bookingType,
            paymentType: b.paymentType,
            subject: b.subject,
            studentName: b.studentName,
            studentEmail: b.studentEmail,
            studentPhone: b.studentPhone,
            guardianName: b.guardianName,
            guardianEmail: b.guardianEmail,
            guardianPhone: b.guardianPhone,
            totalDueMinor: b.totalDueMinor,
            depositPaidMinor: b.depositPaidMinor,
            accomFeeMinor: b.accomFeeMinor,
            researchProgramMinor: b.researchProgramMinor,
            weeks: b.weeks,
            noOfDays: b.noOfDays,
            status: b.status,
            agent: b.agent,
            dateOfPayment: b.dateOfPayment,
            notes: b.notes,
          }
          await ctx.db.summerCampBooking.upsert({
            where: { dedupeKey: b.dedupeKey },
            create: {
              id: createId(),
              dedupeKey: b.dedupeKey,
              ...data,
              createdById: user.id,
              updatedById: user.id,
            },
            update: { ...data, updatedById: user.id, deletedAt: null },
          })
          if (existingKeys.has(b.dedupeKey)) updated += 1
          else created += 1
        }

        await ctx.audit({
          action: 'summer_camp.instalments_imported',
          target: { type: 'System', id: 'summer_camp_instalments' },
          after: { created, updated, total: byKey.size },
        })
        return { created, updated, total: byKey.size }
      }),

    /** Edit a booking's money / status (e.g. record a further instalment by
     *  raising depositPaid). Manager+. */
    update: auditedProcedure
      .input(
        z.object({
          id: z.string(),
          totalDueMinor: z.number().int().min(0).optional(),
          depositPaidMinor: z.number().int().min(0).optional(),
          paymentType: z.string().trim().max(60).nullish(),
          status: z.string().trim().max(60).nullish(),
          notes: z.string().trim().max(4000).nullish(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanWriteInstalments(user.role)
        const row = await ctx.db.summerCampBooking.findFirst({
          where: { id: input.id, deletedAt: null },
        })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
        const data: Prisma.SummerCampBookingUpdateInput = { updatedById: user.id }
        if (input.totalDueMinor !== undefined) data.totalDueMinor = input.totalDueMinor
        if (input.depositPaidMinor !== undefined) data.depositPaidMinor = input.depositPaidMinor
        if (input.paymentType !== undefined) data.paymentType = input.paymentType
        if (input.status !== undefined) data.status = input.status
        if (input.notes !== undefined) data.notes = input.notes
        await ctx.db.summerCampBooking.update({ where: { id: row.id }, data })
        await ctx.audit({
          action: 'summer_camp.instalment_updated',
          target: { type: 'SummerCampBooking', id: row.id },
          before: { totalDueMinor: row.totalDueMinor, depositPaidMinor: row.depositPaidMinor },
          after: {
            totalDueMinor: input.totalDueMinor ?? row.totalDueMinor,
            depositPaidMinor: input.depositPaidMinor ?? row.depositPaidMinor,
          },
        })
        return { ok: true }
      }),

    /** Soft-delete a booking row (a duplicate or a mistake). Manager+. */
    remove: auditedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanWriteInstalments(user.role)
        const row = await ctx.db.summerCampBooking.findFirst({
          where: { id: input.id, deletedAt: null },
          select: { id: true },
        })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
        await ctx.db.summerCampBooking.update({
          where: { id: row.id },
          data: { deletedAt: new Date(), updatedById: user.id },
        })
        await ctx.audit({
          action: 'summer_camp.instalment_deleted',
          target: { type: 'SummerCampBooking', id: row.id },
        })
        return { ok: true }
      }),
  }),
})
