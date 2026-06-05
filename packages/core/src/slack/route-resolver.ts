// Resolve which Slack channel a notification topic should post to (ADR 0033).
// Senders call this instead of reading an env var directly, so the destination
// is operator-controlled from Settings → Slack channels → "Where notifications
// go". Takes `db` as a parameter (the core convention) so both integration
// senders and the web boundaries can use it.
//
// Resolution order:
//   1. The topic's SlackRoute, if one exists:
//        - enabled = false           → null  (muted; don't post)
//        - has a live channelOption  → that channel
//        - enabled but no channel    → fall through
//   2. The caller's env fallback (e.g. SLACK_FINOPS_CHANNEL_ID).
//   3. The default SlackChannelOption.
//   4. SLACK_ALERTS_CHANNEL_ID.
// Returns null when nothing is configured (or the topic is muted); every Slack
// sender already treats a null channel as "skip".

import type { Prisma, PrismaClient } from '@prisma/client'

import type { SlackTopicKey } from './topics'

type Db = PrismaClient | Prisma.TransactionClient

export async function resolveTopicChannelId(
  db: Db,
  topic: SlackTopicKey,
  fallbackEnvChannelId?: string | null,
): Promise<string | null> {
  const route = await db.slackRoute.findUnique({
    where: { topic },
    select: {
      enabled: true,
      channelOption: { select: { channelId: true, archivedAt: true } },
    },
  })

  if (route) {
    if (!route.enabled) return null // explicitly muted
    if (route.channelOption && route.channelOption.archivedAt == null) {
      return route.channelOption.channelId
    }
  }

  if (fallbackEnvChannelId) return fallbackEnvChannelId

  const def = await db.slackChannelOption.findFirst({
    where: { isDefault: true, archivedAt: null },
    select: { channelId: true },
  })
  return def?.channelId ?? process.env['SLACK_ALERTS_CHANNEL_ID'] ?? null
}
