/* eslint-disable no-console */
// DR Step 7: walk ProviderEvent rows in [from, to) and re-enqueue each to
// Inngest. The underlying jobs are idempotent on (provider, eventId)
// (CLAUDE.md §7.1) so this is safe to run multiple times.
//
// Usage:
//   pnpm tsx scripts/dr/replay-provider-events.ts \
//     --from 2026-05-09T08:00:00Z \
//     --to   2026-05-09T09:00:00Z
//
// Per-provider event names follow the per-integration convention used in
// each webhook handler. We dispatch on `provider` to map to the correct
// Inngest event name.

import { PrismaClient } from '@prisma/client'
import { Inngest } from 'inngest'

interface Args {
  from: Date
  to: Date
  batch: number
}

function parseArgs(argv: string[]): Args {
  let from: string | null = null
  let to: string | null = null
  let batch = 500
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') from = argv[++i] ?? null
    else if (a === '--to') to = argv[++i] ?? null
    else if (a === '--batch') batch = Number(argv[++i] ?? batch)
  }
  if (!from || !to) {
    throw new Error('usage: --from <iso> --to <iso> [--batch N]')
  }
  return { from: new Date(from), to: new Date(to), batch }
}

function eventNameForProvider(provider: string): string {
  switch (provider) {
    case 'stripe':
      return 'stripe/event.received'
    case 'gocardless':
      return 'gocardless/event.received'
    case 'aircall':
      return 'aircall/event.received'
    case 'trengo':
      return 'trengo/event.received'
    case 'asana':
      return 'asana/event.received'
    case 'gmail':
      return 'gmail/event.received'
    case 'slack':
      return 'slack/event.received'
    case 'booking':
      return 'booking/event.received'
    default:
      return `${provider}/event.received`
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const prisma = new PrismaClient()
  const inngest = new Inngest({
    id: 'studymind-crm',
    eventKey: process.env['INNGEST_EVENT_KEY'],
  })

  let cursor: string | null = null
  let dispatched = 0
  try {
    while (true) {
      const rows: Array<{ id: string; eventId: string; provider: string }> =
        (await (prisma as unknown as {
          providerEvent: {
            findMany: (args: unknown) => Promise<
              Array<{ id: string; eventId: string; provider: string }>
            >
          }
        }).providerEvent.findMany({
          where: {
            receivedAt: { gte: args.from, lt: args.to },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: args.batch,
          select: { id: true, eventId: true, provider: true },
        }))
      if (rows.length === 0) break
      for (const row of rows) {
        await inngest.send({
          name: eventNameForProvider(row.provider),
          data: { eventId: row.eventId, replay: true },
        })
        dispatched += 1
      }
      cursor = rows[rows.length - 1].id
      console.log(`dispatched=${dispatched} cursor=${cursor}`)
    }
    console.log(`replay complete: dispatched=${dispatched} events`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
