// Inngest functions for the Summer Camp integration. CLAUDE.md §7.1, §17.
//
//   summer-camp/event.received — process one inbound booking webhook async.
//   Loads the persisted ProviderEvent, re-parses the envelope, and applies the
//   enrichment (match/create contacts, link, timeline interaction, audit). The
//   apply step is idempotent, so an Inngest retry is safe.

import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { applyBookingEvent } from './apply'
import { BookingEventEnvelope } from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

export const summerCampEventReceived = inngest.createFunction(
  {
    id: 'summer-camp/event.received',
    name: 'Process Summer Camp booking webhook event',
    concurrency: { limit: 5 },
    retries: 6,
  },
  { event: 'summer-camp/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as EventReceivedData
    const { eventId, providerEventRowId } = data

    const providerEvent = await step.run('load-event', async () => {
      return db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true },
      })
    })

    const result = await step.run('apply', async () => {
      const parsed = BookingEventEnvelope.safeParse(providerEvent.raw)
      if (!parsed.success) return { action: 'skipped' as const, reason: 'unparseable' }
      return applyBookingEvent(db, parsed.data)
    })

    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    logger.info({ eventId, ...result }, 'summer_camp.event.processed')
    return { eventId, ...result }
  },
)

export const FUNCTIONS = [summerCampEventReceived]
