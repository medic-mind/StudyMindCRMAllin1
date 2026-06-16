// Cached Slack id → human-name resolution (users.info / conversations.info).
// The Events API + history payloads carry raw ids only; resolving them makes
// the archived record readable ("Aisha" in "#ops-queries", not U07… in C09…).
// Best-effort by design: a missing token or scope returns nulls and the
// caller keeps the raw ids — resolution must never block the archive.

import { createClient } from './client'

const userCache = new Map<string, string | null>()
const channelCache = new Map<string, string | null>()

export async function resolveSlackNames(input: {
  userId?: string | null
  channelId?: string | null
}): Promise<{ senderName: string | null; channelName: string | null }> {
  let senderName: string | null = null
  let channelName: string | null = null
  try {
    const client = createClient()
    if (input.userId) {
      if (userCache.has(input.userId)) {
        senderName = userCache.get(input.userId) ?? null
      } else {
        senderName = await client.getUserDisplayName(input.userId).catch(() => null)
        userCache.set(input.userId, senderName)
      }
    }
    if (input.channelId) {
      if (channelCache.has(input.channelId)) {
        channelName = channelCache.get(input.channelId) ?? null
      } else {
        channelName = await client.getChannelName(input.channelId).catch(() => null)
        channelCache.set(input.channelId, channelName)
      }
    }
  } catch {
    // SLACK_BOT_TOKEN unset — keep raw ids.
  }
  return { senderName, channelName }
}

/**
 * Best-effort text of a thread's root message, so a reply that names no customer
 * inherits the customer from the message it replies to (ADR 0034 amendment). A
 * missing token / scope / API error returns null and matching falls back to the
 * reply text alone — fetching the parent must never block ingestion.
 */
export async function resolveThreadParentText(input: {
  channelId: string
  threadTs: string
}): Promise<string | null> {
  try {
    const client = createClient()
    return await client.getThreadParentText(input.channelId, input.threadTs).catch(() => null)
  } catch {
    return null
  }
}
