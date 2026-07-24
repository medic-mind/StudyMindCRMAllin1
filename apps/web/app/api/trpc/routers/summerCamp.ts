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
import { createClientFromConfig } from '@studymind/integration-summer-camp/client'
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
  'sales_executive',
  'virtual_assistant',
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
  'sales_executive',
  'virtual_assistant',
])

function assertCanWriteBookings(role: SessionUser['role']): void {
  if (!BOOKING_WRITE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Sales Executive or above can change camp bookings',
    })
  }
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
    .input(
      z
        .object({
          campId: z.string().optional(),
          year: z.number().int().min(2000).max(2100).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      const client = createClientFromConfig()
      if (!client) return { connected: false as const, feed: null }
      try {
        const feed = await client.getTimetable(input?.campId ?? null, input?.year ?? null)
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
    /**
     * The CRM's on-record bookings list. Reads the local CampBookingRecord
     * mirror — the durable central record every sync path upserts — so the
     * workspace stays fast and available even when the camp app is down.
     * The webhook + 15-min sync keep it current; `syncNow` forces it.
     */
    list: protectedProcedure
      .input(
        z
          .object({
            search: z.string().trim().max(120).optional(),
            status: z.enum(['pending', 'confirmed', 'cancelled', 'waitlist']).optional(),
            campId: z.string().trim().min(1).optional(),
            year: z.number().int().min(2000).max(2100).optional(),
            weekNumber: z.number().int().min(0).max(60).optional(),
            unassigned: z.boolean().optional(),
          })
          .default({}),
      )
      .query(async ({ ctx, input }) => {
        requireUser(ctx)
        const notCancelled: Prisma.CampBookingRecordWhereInput = {
          OR: [{ status: null }, { status: { not: 'cancelled' } }],
        }
        const and: Prisma.CampBookingRecordWhereInput[] = [{ deletedAt: null }]
        if (input.status) and.push({ status: input.status })
        // A camp filter implies its season — don't ALSO require campYear, which
        // can lag for date-less bookings (e.g. a Stripe auto-create assigned to
        // next season's camp) and would hide them from their own camp's list.
        if (input.year && !input.campId) and.push({ campYear: input.year })
        if (input.campId) {
          and.push({
            OR: [{ campId: input.campId }, { enrolledCampIds: { array_contains: input.campId } }],
          })
        }
        if (input.weekNumber !== undefined) {
          and.push({
            OR: [
              { weekNumber: input.weekNumber },
              { bookedWeeks: { array_contains: [{ week_number: input.weekNumber }] } },
            ],
          })
        }
        if (input.unassigned) and.push({ campId: null }, notCancelled)
        if (input.search) {
          const q = input.search
          and.push({
            OR: [
              { studentName: { contains: q, mode: 'insensitive' } },
              { studentEmail: { contains: q, mode: 'insensitive' } },
              { guardianName: { contains: q, mode: 'insensitive' } },
              { guardianEmail: { contains: q, mode: 'insensitive' } },
              { campName: { contains: q, mode: 'insensitive' } },
              { subject: { contains: q, mode: 'insensitive' } },
              { agentName: { contains: q, mode: 'insensitive' } },
              { paymentReference: { contains: q, mode: 'insensitive' } },
            ],
          })
        }
        const where: Prisma.CampBookingRecordWhereInput = { AND: and }
        const contactSelect = {
          select: { id: true, kind: true, firstName: true, lastName: true },
        } as const

        const [rows, total, statusGroups, yearGroups, money, unassignedCount, mirrorCount] =
          await Promise.all([
            ctx.db.campBookingRecord.findMany({
              where,
              orderBy: [{ sourceCreatedAt: 'desc' }, { createdAt: 'desc' }],
              take: 400,
              include: { studentContact: contactSelect, guardianContact: contactSelect },
            }),
            ctx.db.campBookingRecord.count({ where }),
            ctx.db.campBookingRecord.groupBy({ by: ['status'], where, _count: { _all: true } }),
            ctx.db.campBookingRecord.groupBy({
              by: ['campYear'],
              where: { deletedAt: null },
              _count: { _all: true },
            }),
            ctx.db.campBookingRecord.aggregate({
              where: { AND: [...and, notCancelled] },
              _sum: { totalMinor: true, paidMinor: true },
            }),
            ctx.db.campBookingRecord.count({
              where: { AND: [{ deletedAt: null }, { campId: null }, notCancelled] },
            }),
            ctx.db.campBookingRecord.count({ where: { deletedAt: null } }),
          ])

        const byStatus: Record<string, number> = {}
        for (const g of statusGroups) byStatus[g.status ?? 'unknown'] = g._count._all

        const contactsFor = (r: (typeof rows)[number]) => {
          const list: { contactId: string; kind: string; name: string }[] = []
          for (const c of [r.guardianContact, r.studentContact]) {
            if (!c || list.some((l) => l.contactId === c.id)) continue
            list.push({
              contactId: c.id,
              kind: String(c.kind),
              name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact',
            })
          }
          return list
        }

        return {
          connected: createClientFromConfig() !== null,
          total,
          mirrorCount,
          stats: {
            byStatus,
            totalMinor: money._sum.totalMinor ?? 0,
            paidMinor: money._sum.paidMinor ?? 0,
            unassigned: unassignedCount,
          },
          years: yearGroups
            .map((g) => g.campYear)
            .filter((y): y is number => typeof y === 'number')
            .sort((a, b) => a - b),
          items: rows.map((r) => ({
            id: r.externalBookingId,
            status: r.status,
            bookingType: r.bookingType,
            campId: r.campId,
            campName: r.campName,
            campYear: r.campYear,
            enrolledCampIds: (Array.isArray(r.enrolledCampIds) ? r.enrolledCampIds : []) as string[],
            subject: r.subject,
            weekNumber: r.weekNumber,
            weekLabel: r.weekLabel,
            startDate: r.startDate ? r.startDate.toISOString() : null,
            endDate: r.endDate ? r.endDate.toISOString() : null,
            multipleWeeks: r.multipleWeeks,
            withAccommodation: r.withAccommodation,
            withTransfer: r.withTransfer,
            totalMinor: r.totalMinor,
            paidMinor: r.paidMinor,
            paymentType: r.paymentType,
            agentName: r.agentName,
            campNotes: r.campNotes,
            studentName: r.studentName,
            studentEmail: r.studentEmail,
            dietaryRequirements: r.dietaryRequirements,
            emergencyContactName: r.emergencyContactName,
            emergencyContactPhone: r.emergencyContactPhone,
            guardianName: r.guardianName,
            guardianEmail: r.guardianEmail,
            guardianPhone: r.guardianPhone,
            notesLog: (Array.isArray(r.notesLog) ? r.notesLog : []) as {
              id: string
              author: string | null
              body: string | null
              created_at?: string | null
              createdAt?: string | null
              source: string | null
            }[],
            contacts: contactsFor(r),
            createdAt: r.sourceCreatedAt ? r.sourceCreatedAt.toISOString() : null,
            updatedAt: r.sourceUpdatedAt ? r.sourceUpdatedAt.toISOString() : null,
            lastSyncedAt: r.lastSyncedAt.toISOString(),
          })),
        }
      }),

    /** Force an immediate re-pull from the camp app (event-triggered variant
     *  of the 15-min cron). Sales Executive+. */
    syncNow: protectedProcedure.mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      assertCanWriteBookings(user.role)
      if (!createClientFromConfig()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Summer Camp app is not connected.' })
      }
      await requestSyncNow()
      return { ok: true }
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
        await ctx.db.campBookingRecord.updateMany({
          where: { externalBookingId: input.bookingId },
          data: {
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.subject !== undefined ? { subject: input.subject } : {}),
            ...(input.notes !== undefined ? { campNotes: input.notes } : {}),
            updatedById: user.id,
          },
        })
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
      .input(
        z.object({
          bookingId: z.string().min(1),
          campIds: z.array(z.string().min(1)).max(20),
          /** Season year the camps were picked from — the camp feed is
           *  year-scoped, so the name lookup must ask for the same season. */
          year: z.number().int().min(2000).max(2100).optional(),
        }),
      )
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

        // Resolve the primary camp's name + season year for the local mirror
        // (best-effort — the sync-now pull corrects it either way).
        const primary = input.campIds[0] ?? null
        let primaryName: string | null = null
        let primaryYear: number | null = null
        if (primary) {
          try {
            const feed = await createClientFromConfig()?.getCamps(input.year)
            const camp = feed?.camps.find((c) => c.id === primary)
            primaryName = camp?.name ?? null
            const start = camp?.start_date ? new Date(camp.start_date) : null
            primaryYear = start && !Number.isNaN(start.getTime()) ? start.getUTCFullYear() : null
          } catch {
            primaryName = null
          }
        }
        await patchLocalBookingInteractions(ctx.db, input.bookingId, {
          campId: primary,
          ...(primary === null || primaryName !== null ? { campName: primaryName } : {}),
          enrolledCampIds: input.campIds,
        })
        await ctx.db.campBookingRecord.updateMany({
          where: { externalBookingId: input.bookingId },
          data: {
            campId: primary,
            ...(primary === null || primaryName !== null ? { campName: primaryName } : {}),
            ...(primaryYear !== null ? { campYear: primaryYear } : {}),
            enrolledCampIds: input.campIds,
            updatedById: user.id,
          },
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

        const record = await ctx.db.campBookingRecord.findUnique({
          where: { externalBookingId: input.bookingId },
          select: { id: true, notesLog: true },
        })
        if (record) {
          const log = Array.isArray(record.notesLog) ? [...(record.notesLog as object[])] : []
          log.push({
            id: push.campNoteId ?? `crm_${createId()}`,
            author: user.email,
            body: input.body,
            created_at: new Date().toISOString(),
            source: 'crm',
          })
          await ctx.db.campBookingRecord.update({
            where: { id: record.id },
            data: { notesLog: log as Prisma.InputJsonValue, updatedById: user.id },
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
  // Stripe purchases detected as Summer Camp / Work Experience. Auto-created
  // as camp bookings through the CRM; this tray is the human control surface
  // (retry / dismiss / historic scan).
  // ---------------------------------------------------------------------------
  purchases: router({
    list: protectedProcedure
      .input(z.object({ view: z.enum(['open', 'resolved', 'all']).default('open') }).default({ view: 'open' }))
      .query(async ({ ctx, input }) => {
        requireUser(ctx)
        const where: Prisma.CampStripePurchaseWhereInput =
          input.view === 'open'
            ? { status: { in: ['pending', 'failed'] } }
            : input.view === 'resolved'
              ? { status: { in: ['booking_created', 'dismissed'] } }
              : {}
        const [rows, groups] = await Promise.all([
          ctx.db.campStripePurchase.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 200,
            include: { contact: { select: { id: true, firstName: true, lastName: true } } },
          }),
          ctx.db.campStripePurchase.groupBy({ by: ['status'], _count: { _all: true } }),
        ])
        const counts: Record<string, number> = {}
        for (const g of groups) counts[g.status] = g._count._all
        return {
          counts,
          campConnected: createClientFromConfig() !== null,
          stripeConfigured: Boolean(process.env['STRIPE_SECRET_KEY']),
          items: rows.map((r) => ({
            id: r.id,
            stripeChargeId: r.stripeChargeId,
            amountMinor: r.amountMinor,
            currency: r.currency,
            customerName: r.customerName,
            customerEmail: r.customerEmail,
            productText: r.productText,
            matchedKeyword: r.matchedKeyword,
            status: r.status,
            error: r.error,
            externalBookingId: r.externalBookingId,
            contactId: r.contactId,
            contactName: r.contact
              ? [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') || null
              : null,
            occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
            createdAt: r.createdAt.toISOString(),
          })),
        }
      }),

    /** Re-run the auto-create for a pending purchase (e.g. after connecting
     *  the camp app, or a transient failure). Sales Executive+. */
    retry: auditedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanWriteBookings(user.role)
        const row = await ctx.db.campStripePurchase.findUnique({ where: { id: input.id } })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
        if (row.status === 'booking_created' || row.status === 'dismissed') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'This purchase is already resolved.' })
        }
        const { inngest } = await import('@studymind/jobs')
        await inngest.send({
          name: 'summer-camp/purchase.detected',
          data: {
            stripeChargeId: row.stripeChargeId,
            stripePaymentIntentId: row.stripePaymentIntentId,
            amountMinor: row.amountMinor,
            currency: row.currency,
            customerName: row.customerName,
            customerEmail: row.customerEmail,
            productText: row.productText,
            matchedKeyword: row.matchedKeyword,
            occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
          },
        })
        await ctx.audit({
          action: 'summer_camp.purchase_retried',
          target: { type: 'CampStripePurchase', id: row.id },
          after: { stripeChargeId: row.stripeChargeId },
        })
        return { ok: true }
      }),

    /** Mark a detection as not-a-camp-purchase (kept on record, never acted
     *  on again). Sales Executive+. */
    dismiss: auditedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanWriteBookings(user.role)
        const row = await ctx.db.campStripePurchase.findUnique({ where: { id: input.id } })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
        if (row.status === 'booking_created') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'A booking was already created for this purchase.' })
        }
        await ctx.db.campStripePurchase.update({
          where: { id: row.id },
          data: { status: 'dismissed', updatedById: user.id },
        })
        await ctx.audit({
          action: 'summer_camp.purchase_dismissed',
          target: { type: 'CampStripePurchase', id: row.id },
          after: { stripeChargeId: row.stripeChargeId },
        })
        return { ok: true }
      }),

    /** Historic scan of recent Stripe charges (auto-creates bookings for
     *  matches). CEO + Senior Manager, like the other mass imports. */
    scanStripe: auditedProcedure
      .input(z.object({ days: z.number().int().min(1).max(730).default(365) }).default({ days: 365 }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!BACKFILL_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
        if (!process.env['STRIPE_SECRET_KEY']) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe is not configured.' })
        }
        const { inngest } = await import('@studymind/jobs')
        await inngest.send({ name: 'summer-camp/scan-purchases.requested', data: { days: input.days } })
        await ctx.audit({
          action: 'summer_camp.purchases_scan_requested',
          target: { type: 'System', id: 'camp_stripe_purchase_scan' },
          after: { days: input.days, initiatedBy: user.id },
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
