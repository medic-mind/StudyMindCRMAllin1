import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PrismaClient } from '@prisma/client'

import {
  resolveTopicChannelWithDiscovery,
  type DiscoverableChannel,
} from './topic-channel'

/** Minimal in-memory stand-in for the Prisma delegates the resolver touches. */
function makeDb(initial?: {
  route?: { enabled: boolean; channelOption: { channelId: string; archivedAt: Date | null; label: string } | null }
  optionsByChannelId?: Record<string, { id: string; archivedAt: Date | null }>
  defaultOption?: { channelId: string; label: string } | null
}) {
  const created: { options: unknown[]; routeUpserts: unknown[]; optionUpdates: unknown[] } = {
    options: [],
    routeUpserts: [],
    optionUpdates: [],
  }
  const optionsByChannelId = { ...(initial?.optionsByChannelId ?? {}) }
  const db = {
    slackRoute: {
      findUnique: vi.fn(async () => initial?.route ?? null),
      upsert: vi.fn(async (args: unknown) => {
        created.routeUpserts.push(args)
        return {}
      }),
    },
    slackChannelOption: {
      findUnique: vi.fn(async (args: { where: { channelId: string } }) => {
        return optionsByChannelId[args.where.channelId] ?? null
      }),
      findFirst: vi.fn(async () => initial?.defaultOption ?? null),
      create: vi.fn(async (args: { data: { id: string; channelId: string } }) => {
        created.options.push(args.data)
        optionsByChannelId[args.data.channelId] = { id: args.data.id, archivedAt: null }
        return args.data
      }),
      update: vi.fn(async (args: unknown) => {
        created.optionUpdates.push(args)
        return {}
      }),
    },
  }
  return { db: db as unknown as PrismaClient, created }
}

const channels: DiscoverableChannel[] = [
  { id: 'C_CALLS', name: 'callsummaries', isMember: true },
  { id: 'C_COMPLAINTS', name: 'Complaint-Call_Summaries', isMember: true },
  { id: 'C_RANDOM', name: 'random', isMember: true },
]

beforeEach(() => {
  delete process.env['SLACK_ALERTS_CHANNEL_ID']
})

describe('resolveTopicChannelWithDiscovery', () => {
  it('uses an explicit enabled route with a live channel', async () => {
    const { db } = makeDb({
      route: { enabled: true, channelOption: { channelId: 'C_EXPLICIT', archivedAt: null, label: '#complaints' } },
    })
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => channels,
    })
    expect(res).toEqual({ channelId: 'C_EXPLICIT', channelName: '#complaints', source: 'route' })
  })

  it('honours an operator mute (enabled=false → do not post)', async () => {
    const { db } = makeDb({ route: { enabled: false, channelOption: null } })
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => channels,
    })
    expect(res).toEqual({ channelId: null, channelName: null, source: 'muted' })
  })

  it('discovers #complaintcallsummaries by name (tolerant of formatting) and wires it up', async () => {
    const { db, created } = makeDb()
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => channels,
      actorId: 'u1',
    })
    expect(res.channelId).toBe('C_COMPLAINTS')
    expect(res.source).toBe('discovered')
    expect(res.channelName).toBe('#Complaint-Call_Summaries')
    // Persisted a channel option + a route so the next send skips discovery.
    expect(created.options).toHaveLength(1)
    expect(created.routeUpserts).toHaveLength(1)
  })

  it('reuses an existing option for the discovered channel (no duplicate)', async () => {
    const { db, created } = makeDb({
      optionsByChannelId: { C_COMPLAINTS: { id: 'opt-existing', archivedAt: null } },
    })
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => channels,
    })
    expect(res.channelId).toBe('C_COMPLAINTS')
    expect(created.options).toHaveLength(0) // reused, not recreated
    expect(created.routeUpserts).toHaveLength(1)
  })

  it('un-archives a previously-archived option it now routes to', async () => {
    const { db, created } = makeDb({
      optionsByChannelId: { C_COMPLAINTS: { id: 'opt-archived', archivedAt: new Date() } },
    })
    await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => channels,
    })
    expect(created.optionUpdates).toHaveLength(1)
  })

  it('falls back to the default channel option when discovery finds nothing', async () => {
    const { db } = makeDb({ defaultOption: { channelId: 'C_DEFAULT', label: '#alerts' } })
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => [], // no scope / not found
    })
    expect(res).toEqual({ channelId: 'C_DEFAULT', channelName: '#alerts', source: 'default' })
  })

  it('falls back to SLACK_ALERTS_CHANNEL_ID when there is no default option', async () => {
    process.env['SLACK_ALERTS_CHANNEL_ID'] = 'C_ENV'
    const { db } = makeDb()
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => [],
    })
    expect(res).toEqual({ channelId: 'C_ENV', channelName: null, source: 'env' })
  })

  it('returns none when nothing is configured at all', async () => {
    const { db } = makeDb()
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => [],
    })
    expect(res).toEqual({ channelId: null, channelName: null, source: 'none' })
  })

  it('degrades gracefully when the channel lister throws', async () => {
    process.env['SLACK_ALERTS_CHANNEL_ID'] = 'C_ENV'
    const { db } = makeDb()
    const res = await resolveTopicChannelWithDiscovery('complaint_call_summary', {
      db,
      listChannels: async () => {
        throw new Error('missing_scope')
      },
    })
    expect(res.channelId).toBe('C_ENV')
    expect(res.source).toBe('env')
  })

  it('does not attempt discovery for a topic with no canonical channel', async () => {
    const listChannels = vi.fn(async () => channels)
    const { db } = makeDb({ defaultOption: { channelId: 'C_DEFAULT', label: '#alerts' } })
    const res = await resolveTopicChannelWithDiscovery('finance_dd_defaulters', { db, listChannels })
    expect(listChannels).not.toHaveBeenCalled()
    expect(res.source).toBe('default')
  })
})
