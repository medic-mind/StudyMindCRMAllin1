// Summer Camp router. Live feeds for the "Summer Camps" surface (roster +
// fill + weekly timetables) plus the bookings workspace: staff can edit a
// booking's status/subject/notes, assign the student to camps, and add notes —
// every write goes to the camp app first (it owns bookings), is audited here,
// and converges via the webhook/reconcile pull. CLAUDE.md §27.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  instalmentState,
  isOnInstalments,
  parseInstalmentCsv,
  remainingMinor,
  summariseInstalments,
} from '@studymind/core/camp'
import { filterBookings } from '@studymind/integration-summer-camp/bookings-filter'
import { createClientFromConfig } from '@studymind/integration-summer-camp/client'
import { BookingResource } from '@studymind/integration-summer-camp/types'
import {
  pushBookingFields,
  pushCampAssignment,
  pushNoteForBooking,
} from '@studymind/integration-summer-camp/writeback'

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

// Booking write-backs (edit status/subject/notes, assign camps) mutate the
// live camp app — Sales Executive and above (§20: VA is read-only + notes).
const BOOKING_WRITE_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])
// Cancelling a real paid booking is money-adjacent — Manager and above.
const BOOKING_CANCEL_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

function assertCanWriteBookings(role: SessionUser['role']): void {
  if (!BOOKING_WRITE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Sales Executive or above can change camp bookings',
    })
  }
}

/** Live-feed page walk shared by the bookings workspace. Bounded so a huge
 *  season can't make one request unbounded (10 × 500 = 5k bookings). */
const BOOKINGS_PAGE_SIZE = 500
const BOOKINGS_MAX_PAGES = 10

async function pullAllBookings(client: NonNullable<ReturnType<typeof createClientFromConfig>>) {
  const bookings: BookingResource[] = []
  let cursor: string | null = null
  for (let page = 0; page < BOOKINGS_MAX_PAGES; page += 1) {
    const res = await client.getBookings({ cursor, limit: BOOKINGS_PAGE_SIZE })
    for (const raw of res.bookings) {
      const parsed = BookingResource.safeParse(raw)
      if (parsed.success) bookings.push(parsed.data)
    }
    if (!res.nextCursor) break
    cursor = res.nextCursor
  }
  return bookings
}

/** CRM contacts linked to a set of camp bookings, keyed by external booking
 *  id, via the `booking` Interactions the sync writes (payload.externalBookingId). */
async function loadBookingContactLinks(
  db: PrismaClient,
  externalBookingIds: string[],
): Promise<Map<string, { contactId: string; kind: string; name: string }[]>> {
  const map = new Map<string, { contactId: string; kind: string; name: string }[]>()
  if (externalBookingIds.length === 0) return map
  const rows = await db.interaction.findMany({
    where: {
      type: 'booking',
      payload: { path: ['kind'], equals: 'summer_camp.booking' },
      contactId: { not: null },
    },
    select: {
      contactId: true,
      payload: true,
      contact: { select: { kind: true, firstName: true, lastName: true } },
    },
    take: 20_000,
  })
  const wanted = new Set(externalBookingIds)
  for (const row of rows) {
    const payload = row.payload as { externalBookingId?: unknown } | null
    const extId = payload?.externalBookingId
    if (typeof extId !== 'string' || !wanted.has(extId) || !row.contactId) continue
    const list = map.get(extId) ?? []
    if (!list.some((l) => l.contactId === row.contactId)) {
      list.push({
        contactId: row.contactId,
        kind: row.contact?.kind ?? 'unclassified',
        name:
          [row.contact?.firstName, row.contact?.lastName].filter(Boolean).join(' ') || 'Contact',
      })
    }
    map.set(extId, list)
  }
  return map
}

/** Patch the mirrored booking Interactions immediately after a successful
 *  write-back so the UI reflects the change before the next feed pull. */
async function patchLocalBookingInteractions(
  db: PrismaClient,
  externalBookingId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const rows = await db.interaction.findMany({
    where: { type: 'booking', payload: { path: ['externalBookingId'], equals: externalBookingId } },
    select: { id: true, payload: true },
  })
  for (const row of rows) {
    const payload = { ...(row.payload as Record<string, unknown>), ...patch }
    await db.interaction.update({
      where: { id: row.id },
      data: { payload: payload as Prisma.InputJsonValue },
    })
  }
}

/** Ask the recurring sync to converge NOW (event-triggered variant of the
 *  15-min cron) so a write-back round-trips within seconds. Best-effort. */
async function requestSyncNow(): Promise<void> {
  try {
    const { inngest } = await import('@studymind/jobs')
    await inngest.send({ name: 'summer-camp/sync-bookings.requested', data: {} })
  } catch {
    // The 15-min cron remains the safety net.
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
  // Bookings workspace. Reads pull the LIVE camp feed (the camp owns bookings —
  // golden rule #4: external API is the source of truth, not our mirror);
  // writes go to the camp app first and only then reflect locally + audit.
  // ---------------------------------------------------------------------------
  bookings: router({
    /** Live bookings list with search + facet filters. */
    list: protectedProcedure
      .input(
        z
          .object({
            search: z.string().trim().max(120).optional(),
            status: z.enum(['pending', 'confirmed', 'cancelled', 'waitlist']).optional(),
            campId: z.string().trim().min(1).optional(),
            weekNumber: z.number().int().min(0).max(60).optional(),
            unassigned: z.boolean().optional(),
          })
          .default({}),
      )
      .query(async ({ ctx, input }) => {
        requireUser(ctx)
        const client = createClientFromConfig()
        if (!client) return { connected: false as const, items: [], total: 0 }
        let all: BookingResource[]
        try {
          all = await pullAllBookings(client)
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'summer camp bookings feed unavailable',
          })
        }
        const filtered = filterBookings(all, {
          search: input.search ?? null,
          status: input.status ?? null,
          campId: input.campId ?? null,
          weekNumber: input.weekNumber ?? null,
          unassigned: input.unassigned ?? false,
        })
        // Newest first, capped for the client.
        filtered.sort((a, b) => {
          const at = a.created_at ? new Date(a.created_at).getTime() : 0
          const bt = b.created_at ? new Date(b.created_at).getTime() : 0
          return bt - at
        })
        const page = filtered.slice(0, 400)
        const links = await loadBookingContactLinks(
          ctx.db,
          page.map((b) => b.id),
        )
        return {
          connected: true as const,
          total: filtered.length,
          items: page.map((b) => ({
            id: b.id,
            status: b.status ?? null,
            bookingType: b.booking_type ?? null,
            campId: b.camp_id ?? null,
            campName: b.camp_name ?? null,
            enrolledCampIds: b.enrolled_camp_ids ?? (b.camp_id ? [b.camp_id] : []),
            subject: b.subject ?? null,
            weekNumber: b.week_number ?? null,
            weekLabel: b.week_label ?? null,
            startDate: b.start_date ?? null,
            endDate: b.end_date ?? null,
            multipleWeeks: b.multiple_weeks ?? false,
            withAccommodation: b.with_accommodation ?? false,
            withTransfer: b.with_transfer ?? false,
            totalMinor: b.payment?.total_minor ?? null,
            paidMinor: b.payment?.paid_minor ?? null,
            paymentType: b.payment?.type ?? null,
            agentName: b.agent_name ?? null,
            campNotes: b.notes ?? null,
            studentName:
              [b.student?.first_name, b.student?.last_name].filter(Boolean).join(' ') || null,
            studentEmail: b.student?.email ?? null,
            dietaryRequirements: b.student?.dietary_requirements ?? null,
            emergencyContactName: b.student?.emergency_contact_name ?? null,
            emergencyContactPhone: b.student?.emergency_contact_phone ?? null,
            guardianName: b.guardian?.name ?? null,
            guardianEmail: b.guardian?.email ?? null,
            guardianPhone: b.guardian?.mobile ?? null,
            notesLog: (b.notes_log ?? []).map((n) => ({
              id: n.id,
              author: n.author ?? null,
              body: n.body ?? null,
              createdAt: n.created_at ?? null,
              source: n.source ?? null,
            })),
            contacts: links.get(b.id) ?? [],
            createdAt: b.created_at ?? null,
            updatedAt: b.updated_at ?? null,
          })),
        }
      }),

    /** Edit the camp-writable booking fields: status, subject, booking notes.
     *  Camp first; local mirror patched; sync-now event confirms convergence. */
    update: auditedProcedure
      .input(
        z.object({
          bookingId: z.string().min(1),
          status: z.enum(['pending', 'confirmed', 'cancelled', 'waitlist']).optional(),
          subject: z.string().trim().max(120).optional(),
          notes: z.string().trim().max(4000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanWriteBookings(user.role)
        if (input.status === undefined && input.subject === undefined && input.notes === undefined) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing to update' })
        }
        if (input.status === 'cancelled' && !BOOKING_CANCEL_ROLES.has(user.role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only Manager or above can cancel a camp booking',
          })
        }
        const push = await pushBookingFields(input.bookingId, {
          status: input.status,
          subject: input.subject,
          notes: input.notes,
        })
        if (!push.ok) {
          throw new TRPCError({
            code: push.skipped ? 'PRECONDITION_FAILED' : 'BAD_GATEWAY',
            message: push.skipped
              ? 'Summer Camp app is not connected — booking edits need the live connection.'
              : `The camp app rejected the update: ${push.reason ?? 'unknown error'}`,
          })
        }

        const patch: Record<string, unknown> = {}
        if (input.status !== undefined) patch['status'] = input.status
        if (input.subject !== undefined) patch['subject'] = input.subject
        await patchLocalBookingInteractions(ctx.db, input.bookingId, patch)
        await requestSyncNow()

        await ctx.audit({
          action:
            input.status === 'cancelled'
              ? 'summer_camp.booking_cancelled_from_crm'
              : 'summer_camp.booking_updated_from_crm',
          target: { type: 'System', id: input.bookingId },
          after: { status: input.status, subject: input.subject, notes: input.notes },
        })
        return { ok: true }
      }),

    /** Assign the booking's student to camps (first id = primary; empty array
     *  clears). The camp app owns assignment — it writes student_enrolments
     *  and the primary camp; we mirror + audit. */
    assignCamps: auditedProcedure
      .input(z.object({ bookingId: z.string().min(1), campIds: z.array(z.string().min(1)).max(20) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanWriteBookings(user.role)
        const push = await pushCampAssignment(input.bookingId, input.campIds)
        if (!push.ok) {
          throw new TRPCError({
            code: push.skipped ? 'PRECONDITION_FAILED' : 'BAD_GATEWAY',
            message: push.skipped
              ? 'Summer Camp app is not connected — camp assignment needs the live connection.'
              : `The camp app rejected the assignment: ${push.reason ?? 'unknown error'}`,
          })
        }

        // Resolve the primary camp's name for the local mirror (best-effort —
        // the sync-now pull corrects it either way).
        const primary = input.campIds[0] ?? null
        let primaryName: string | null = null
        if (primary) {
          try {
            const feed = await createClientFromConfig()?.getCamps()
            primaryName = feed?.camps.find((c) => c.id === primary)?.name ?? null
          } catch {
            primaryName = null
          }
        }
        await patchLocalBookingInteractions(ctx.db, input.bookingId, {
          campId: primary,
          ...(primary === null || primaryName !== null ? { campName: primaryName } : {}),
          enrolledCampIds: input.campIds,
        })
        await requestSyncNow()

        await ctx.audit({
          action: 'summer_camp.booking_camps_assigned',
          target: { type: 'System', id: input.bookingId },
          after: { campIds: input.campIds, primaryCampName: primaryName },
        })
        return { ok: true, primaryCampName: primaryName }
      }),

    /** Add a note to a specific camp booking (shared with the camp site). Any
     *  staff — matches §20 (Virtual Assistant writes notes). */
    addNote: auditedProcedure
      .input(z.object({ bookingId: z.string().min(1), body: z.string().trim().min(1).max(4000) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        const push = await pushNoteForBooking(input.bookingId, input.body, user.email)
        if (!push.ok) {
          throw new TRPCError({
            code: push.skipped ? 'PRECONDITION_FAILED' : 'BAD_GATEWAY',
            message: push.skipped
              ? 'Summer Camp app is not connected — notes need the live connection.'
              : `The camp app rejected the note: ${push.reason ?? 'unknown error'}`,
          })
        }

        // Reflect the note on the linked customer timeline immediately, keyed
        // on the camp's note id so the feed round-trip never duplicates it.
        const links = await loadBookingContactLinks(ctx.db, [input.bookingId])
        const linked = links.get(input.bookingId) ?? []
        const primary = linked.find((l) => l.kind === 'parent') ?? linked[0]
        if (primary) {
          await ctx.db.interaction.create({
            data: {
              id: createId(),
              type: 'note',
              contactId: primary.contactId,
              occurredAt: new Date(),
              summary: input.body.slice(0, 280),
              payload: {
                kind: 'summer_camp.note',
                campNoteId: push.campNoteId ?? null,
                author: user.email,
                source: 'crm',
                externalBookingId: input.bookingId,
                body: input.body,
              },
              createdById: user.id,
            },
          })
        }

        await ctx.audit({
          action: 'summer_camp.booking_note_added',
          target: primary
            ? { type: 'Contact', id: primary.contactId }
            : { type: 'System', id: input.bookingId },
          after: { bookingId: input.bookingId, pushed: true },
        })
        return { ok: true }
      }),
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
