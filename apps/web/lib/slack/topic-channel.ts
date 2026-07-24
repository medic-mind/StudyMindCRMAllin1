// Discovery-aware Slack topic → channel resolver.
//
// The plain `resolveTopicChannelId` (packages/core) resolves a notification
// topic to a channel purely from the DB: an explicit route → the default
// channel option → SLACK_ALERTS_CHANNEL_ID. That means a topic with no route
// configured silently lands in the GENERIC default channel — which is exactly
// how complaint summaries ended up somewhere other than the operator's
// #complaintcallsummaries channel.
//
// This resolver adds the missing step: when a topic has a well-known channel
// NAME (SLACK_TOPICS[].defaultChannelName) and no explicit route is set, it
// auto-discovers the Slack channel with that name and wires it up (persists a
// SlackChannelOption + SlackRoute) so the message reaches the channel it is
// meant for with zero configuration — and reports the REAL destination back so
// the UI never lies about where a complaint went.
//
// Best-effort throughout: discovery / persistence failures degrade to the
// generic fallback, never throwing, so a Slack hiccup never blocks logging.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'

import {
  getTopicDefaultChannelName,
  normaliseSlackChannelName,
  type SlackTopicKey,
} from '@studymind/core/slack'

import { db as defaultDb } from '@/lib/db'

export type TopicChannelSource =
  | 'route' // an explicit, operator-configured route
  | 'discovered' // auto-matched by the topic's well-known channel name
  | 'default' // the default SlackChannelOption
  | 'env' // SLACK_ALERTS_CHANNEL_ID / a caller env fallback
  | 'muted' // the operator explicitly switched this topic off
  | 'none' // nothing configured

export interface TopicChannelResolution {
  /** The channel to post to, or null when muted / nothing configured. */
  channelId: string | null
  /** Best-effort human name (e.g. "#complaintcallsummaries") for honest UI. */
  channelName: string | null
  source: TopicChannelSource
}

/** One Slack channel as seen by `conversations.list` — the fields we need. */
export interface DiscoverableChannel {
  id: string
  name: string
  isMember: boolean
}

export interface ResolveTopicChannelDeps {
  db?: PrismaClient
  /**
   * Best-effort list of the workspace's channels (name + id + membership).
   * Returns `[]` when Slack isn't configured or the token lacks the
   * `channels:read` scope. Injected in tests; defaults to the real client.
   */
  listChannels?: () => Promise<DiscoverableChannel[]>
  /** Caller env fallback (e.g. SLACK_FINOPS_CHANNEL_ID). */
  fallbackEnvChannelId?: string | null
  /** Actor stamped on any auto-created option / route rows. */
  actorId?: string | null
}

/** The live Slack channel lister — best-effort, never throws. */
async function defaultListChannels(): Promise<DiscoverableChannel[]> {
  if (!process.env['SLACK_BOT_TOKEN']) return []
  try {
    const { createClient } = await import('@studymind/integration-slack/client')
    const channels = await createClient().listChannels()
    return channels.map((c) => ({ id: c.id, name: c.name, isMember: c.isMember }))
  } catch {
    // No scope / network / token issue — degrade to the generic fallback.
    return []
  }
}

/**
 * Persist a discovered channel as a SlackChannelOption + SlackRoute so it shows
 * in Settings → Slack channels and every later send resolves it from the DB
 * (step 1) without another Slack API round-trip. We only reach here when there
 * is no live routed channel, so filling the route in is always safe. Best-effort.
 */
async function persistDiscoveredRoute(
  db: PrismaClient,
  topic: SlackTopicKey,
  target: DiscoverableChannel,
  actorId: string | null,
): Promise<void> {
  const existing = await db.slackChannelOption.findUnique({
    where: { channelId: target.id },
    select: { id: true, archivedAt: true },
  })
  let optionId: string
  if (existing) {
    optionId = existing.id
    // We're actively routing to it now — un-archive so it isn't skipped as a
    // dead option on the next resolve (and so it's visible/manageable again).
    if (existing.archivedAt) {
      await db.slackChannelOption.update({
        where: { id: optionId },
        data: { archivedAt: null, updatedById: actorId },
      })
    }
  } else {
    optionId = createId()
    await db.slackChannelOption.create({
      data: {
        id: optionId,
        label: `#${target.name}`,
        channelId: target.id,
        purpose: 'Auto-added — the channel this notification is routed to by name.',
        createdById: actorId,
        updatedById: actorId,
      },
    })
  }
  await db.slackRoute.upsert({
    where: { topic },
    create: {
      id: createId(),
      topic,
      channelOptionId: optionId,
      enabled: true,
      createdById: actorId,
      updatedById: actorId,
    },
    // Only ever called when the route is absent or has no live channel, so
    // pointing it at the discovered channel never clobbers an explicit choice.
    update: { channelOptionId: optionId, enabled: true, updatedById: actorId },
  })
}

/**
 * Resolve a notification topic to the channel it should post to, discovering
 * and wiring up the topic's well-known channel by name when no explicit route
 * exists. See the file header for why this is needed. Never throws.
 */
export async function resolveTopicChannelWithDiscovery(
  topic: SlackTopicKey,
  deps: ResolveTopicChannelDeps = {},
): Promise<TopicChannelResolution> {
  const db = deps.db ?? defaultDb

  // 1) Explicit route wins. Respect an operator mute; use a live routed channel.
  const route = await db.slackRoute.findUnique({
    where: { topic },
    select: {
      enabled: true,
      channelOption: { select: { channelId: true, archivedAt: true, label: true } },
    },
  })
  if (route && !route.enabled) {
    return { channelId: null, channelName: null, source: 'muted' }
  }
  if (route?.channelOption && route.channelOption.archivedAt == null) {
    return {
      channelId: route.channelOption.channelId,
      channelName: route.channelOption.label,
      source: 'route',
    }
  }

  // 2) No usable route — discover the topic's well-known channel BY NAME and
  //    wire it up, so a complaint reaches #complaintcallsummaries even before
  //    anyone opens Settings.
  const wanted = getTopicDefaultChannelName(topic)
  if (wanted) {
    const lister = deps.listChannels ?? defaultListChannels
    const channels = await lister().catch(() => [] as DiscoverableChannel[])
    const wantedKey = normaliseSlackChannelName(wanted)
    // Channel names are unique per workspace; if more than one somehow matches,
    // prefer one the bot is already in (so the post won't 'not_in_channel').
    const matches = channels.filter((c) => normaliseSlackChannelName(c.name) === wantedKey)
    const target = matches.find((c) => c.isMember) ?? matches[0]
    if (target) {
      await persistDiscoveredRoute(db, topic, target, deps.actorId ?? null).catch(() => undefined)
      return { channelId: target.id, channelName: `#${target.name}`, source: 'discovered' }
    }
  }

  // 3) Generic fallbacks (same order as resolveTopicChannelId).
  if (deps.fallbackEnvChannelId) {
    return { channelId: deps.fallbackEnvChannelId, channelName: null, source: 'env' }
  }
  const def = await db.slackChannelOption.findFirst({
    where: { isDefault: true, archivedAt: null },
    select: { channelId: true, label: true },
  })
  if (def) return { channelId: def.channelId, channelName: def.label, source: 'default' }
  const envChannel = process.env['SLACK_ALERTS_CHANNEL_ID'] ?? null
  if (envChannel) return { channelId: envChannel, channelName: null, source: 'env' }
  return { channelId: null, channelName: null, source: 'none' }
}
