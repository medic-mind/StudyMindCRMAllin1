// Recurring Inngest jobs that pull booking data from booking.studymind.co.uk.
// CLAUDE.md §15 (booking site is the source of truth for hours), §17.1
// (active families every 5 min, inactive hourly), §17 (idempotency,
// granular step.run, concurrency).

import { createId } from '@paralleldrive/cuid2'

import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient } from './client'
import type { BookingResource, BookingSessionResource } from './types'

const ACTIVE_STATES = ['trial', 'active', 'at_risk'] as const
const INACTIVE_STATES = ['lead', 'churned'] as const

// How far back to look the first time we sync a family. Five years is the
// effective ceiling for the booking site dataset and keeps the first run
// deterministic without requiring config.
const FIRST_SYNC_LOOKBACK_MS = 5 * 365 * 24 * 60 * 60 * 1000

interface FamilyRow {
  id: string
  lastBookingSyncAt: Date | null
}

async function syncOneFamily(family: FamilyRow): Promise<{
  bookings: number
  sessions: number
  newlyDelivered: number
}> {
  const client = createClient()
  const since = family.lastBookingSyncAt ?? new Date(Date.now() - FIRST_SYNC_LOOKBACK_MS)
  const startedAt = new Date()

  const bookings = await client.listBookingsForFamily(family.id, since)
  let sessionsTouched = 0
  let newlyDelivered = 0

  for (const booking of bookings) {
    await upsertBooking(family.id, booking)
    const sessions = await client.listSessionsForBooking(booking.externalId, since)
    for (const session of sessions) {
      const result = await upsertSession(family.id, booking.externalId, session)
      sessionsTouched += 1
      if (result.transitionedToDelivered) newlyDelivered += 1
    }
  }

  await db.family.update({
    where: { id: family.id },
    data: { lastBookingSyncAt: startedAt },
  })

  return { bookings: bookings.length, sessions: sessionsTouched, newlyDelivered }
}

async function upsertBooking(familyId: string, booking: BookingResource): Promise<void> {
  const existing = await db.booking.findUnique({
    where: { externalId: booking.externalId },
    select: { id: true },
  })
  if (existing) {
    await db.booking.update({
      where: { id: existing.id },
      data: {
        state: booking.state,
        contractedHours: Math.round(booking.contractedHours),
      },
    })
    return
  }
  await db.booking.create({
    data: {
      id: createId(),
      familyId,
      externalId: booking.externalId,
      state: booking.state,
      contractedHours: Math.round(booking.contractedHours),
    },
  })
}

interface UpsertSessionResult {
  id: string
  transitionedToDelivered: boolean
}

async function upsertSession(
  familyId: string,
  externalBookingId: string,
  session: BookingSessionResource,
): Promise<UpsertSessionResult> {
  const booking = await db.booking.findUnique({
    where: { externalId: externalBookingId },
    select: { id: true },
  })
  if (!booking) {
    // Booking row missing — caller upserts the booking before its sessions,
    // so this is a real anomaly. Surface and skip rather than auto-create.
    throw new Error(`Booking ${externalBookingId} missing while upserting session ${session.externalId}`)
  }

  const existing = await db.bookingSession.findUnique({
    where: { externalId: session.externalId },
    select: { id: true, state: true },
  })

  const wasDelivered = existing?.state === 'delivered'
  const isDelivered = session.state === 'delivered'

  const data = {
    bookingId: booking.id,
    scheduledAt: session.scheduledAt,
    state: session.state,
    hours: Math.round(session.deliveredHours || session.scheduledHours || session.contractedHours),
    contractedHours: Math.round(session.contractedHours),
    scheduledHours: Math.round(session.scheduledHours),
    deliveredHours: Math.round(session.deliveredHours),
  }

  if (existing) {
    await db.bookingSession.update({ where: { id: existing.id }, data })
    if (!wasDelivered && isDelivered) {
      await writeDeliveredInteraction(familyId, session)
    }
    return { id: existing.id, transitionedToDelivered: !wasDelivered && isDelivered }
  }

  const row = await db.bookingSession.create({
    data: { id: createId(), externalId: session.externalId, ...data },
    select: { id: true },
  })
  if (isDelivered) {
    await writeDeliveredInteraction(familyId, session)
  }
  return { id: row.id, transitionedToDelivered: isDelivered }
}

async function writeDeliveredInteraction(
  familyId: string,
  session: BookingSessionResource,
): Promise<void> {
  // Idempotent on (familyId, externalSessionId).
  const existing = await db.interaction.findFirst({
    where: {
      familyId,
      type: 'booking',
      payload: { path: ['externalSessionId'], equals: session.externalId },
    },
    select: { id: true },
  })
  if (existing) return

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'booking',
      familyId,
      occurredAt: session.scheduledAt,
      summary: `Session delivered (${session.deliveredHours}h)`,
      payload: {
        kind: 'booking.session_delivered',
        externalSessionId: session.externalId,
        deliveredHours: session.deliveredHours,
        scheduledAt: session.scheduledAt.toISOString(),
      },
    },
  })
}

export const bookingSyncActiveFamilies = inngest.createFunction(
  {
    id: 'booking/sync-active-families',
    name: 'Booking: pull changes for active families',
    concurrency: { limit: 5 },
    retries: 3,
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const families = await step.run('list-active-families', async () => {
      return db.family.findMany({
        where: { state: { in: [...ACTIVE_STATES] }, deletedAt: null },
        select: { id: true, lastBookingSyncAt: true },
        take: 500,
      })
    })

    let bookings = 0
    let sessions = 0
    let newlyDelivered = 0
    for (const family of families) {
      const result = await step.run(`sync-${family.id}`, async () =>
        syncOneFamily({
          id: family.id,
          lastBookingSyncAt: family.lastBookingSyncAt ? new Date(family.lastBookingSyncAt) : null,
        }),
      )
      bookings += result.bookings
      sessions += result.sessions
      newlyDelivered += result.newlyDelivered
    }

    logger.info(
      { families: families.length, bookings, sessions, newlyDelivered },
      'booking sync (active) complete',
    )
    return { families: families.length, bookings, sessions, newlyDelivered }
  },
)

export const bookingSyncInactiveFamilies = inngest.createFunction(
  {
    id: 'booking/sync-inactive-families',
    name: 'Booking: pull changes for inactive families',
    concurrency: { limit: 5 },
    retries: 3,
  },
  { cron: '0 * * * *' },
  async ({ step, logger }) => {
    const families = await step.run('list-inactive-families', async () => {
      return db.family.findMany({
        where: { state: { in: [...INACTIVE_STATES] }, deletedAt: null },
        select: { id: true, lastBookingSyncAt: true },
        take: 500,
      })
    })

    let bookings = 0
    let sessions = 0
    let newlyDelivered = 0
    for (const family of families) {
      const result = await step.run(`sync-${family.id}`, async () =>
        syncOneFamily({
          id: family.id,
          lastBookingSyncAt: family.lastBookingSyncAt ? new Date(family.lastBookingSyncAt) : null,
        }),
      )
      bookings += result.bookings
      sessions += result.sessions
      newlyDelivered += result.newlyDelivered
    }

    logger.info(
      { families: families.length, bookings, sessions, newlyDelivered },
      'booking sync (inactive) complete',
    )
    return { families: families.length, bookings, sessions, newlyDelivered }
  },
)

export const FUNCTIONS = [bookingSyncActiveFamilies, bookingSyncInactiveFamilies] as const

export const JOBS: readonly { id: string; description: string }[] = [
  { id: 'booking/sync-active-families', description: 'Pull booking changes for active Families' },
  {
    id: 'booking/sync-inactive-families',
    description: 'Pull booking changes for inactive Families',
  },
]
