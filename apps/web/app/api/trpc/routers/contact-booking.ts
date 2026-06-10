// Booking-site mirror for a contact (ADR 0029): registration status, the hours
// balance, and the lessons that have taken place. Read-only; surfaced on the
// contact page and populated once the booking API token is set (CLAUDE.md §15).
//
// Kept as its own small router (merged into `contact.booking.*` in root.ts,
// like `contact.channels`) so the already-large contact router's type
// inference stays cheap.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { protectedProcedure, router } from '@/lib/trpc/builders'

/** Prisma Decimal → number (null-safe). */
function dec(d: unknown): number | null {
  return d == null ? null : Number(d)
}

export const contactBookingRouter = router({
  summary: protectedProcedure
    .input(z.object({ contactId: z.string() }))
    .query(async ({ ctx, input }) => {
      const contact = await ctx.db.contact.findFirst({
        where: { id: input.contactId, deletedAt: null },
        select: {
          bookingStatus: true,
          bookingContactId: true,
          hoursBooked: true,
          hoursDelivered: true,
          lastLessonAt: true,
          amountSpentMinor: true,
          bookingProfile: true,
        },
      })
      if (!contact) throw new TRPCError({ code: 'NOT_FOUND' })
      const p = contact.bookingProfile
      return {
        bookingStatus: contact.bookingStatus,
        registeredOnBookingSite: contact.bookingContactId != null,
        hoursBooked: contact.hoursBooked,
        hoursDelivered: contact.hoursDelivered,
        lastLessonAt: contact.lastLessonAt,
        amountSpentMinor: contact.amountSpentMinor,
        profile: p
          ? {
              hoursAdded: dec(p.hoursAdded),
              hoursUsed: dec(p.hoursUsed),
              hoursRemaining: dec(p.hoursRemaining),
              premiumHoursRemaining: dec(p.premiumHoursRemaining),
              nextHoursExpiryAt: p.nextHoursExpiryAt,
              creditsOnlineMmi: p.creditsOnlineMmi,
              creditsInPersonMmi: p.creditsInPersonMmi,
              creditsLiveDay: p.creditsLiveDay,
              creditsInPersonLiveDay: p.creditsInPersonLiveDay,
              hasGuardian: p.hasGuardian,
              guardianName: p.guardianName,
              guardianEmail: p.guardianEmail,
              guardianPhoneE164: p.guardianPhoneE164,
              registeredAt: p.registeredAt,
              lastSyncedAt: p.lastSyncedAt,
            }
          : null,
      }
    }),

  lessons: protectedProcedure
    .input(
      z.object({
        contactId: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.db.bookingLesson.findMany({
        where: { contactId: input.contactId, deletedAt: null },
        orderBy: [{ startsAt: 'desc' }],
        take: input.limit,
        select: {
          id: true,
          subject: true,
          tutorName: true,
          startsAt: true,
          endsAt: true,
          durationMinutes: true,
          status: true,
          payment: true,
          isTrial: true,
        },
      })
    }),
})
