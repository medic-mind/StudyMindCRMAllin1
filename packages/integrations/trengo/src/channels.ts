// Trengo channel mirror (CLAUDE.md §11). Pulls the workspace's CHANNELS — the
// individual "business numbers" / inboxes (a WhatsApp Business line named
// "Support Manager", an SMS sender "Tutor Manager", a mailbox, the web widget,
// …) — from `GET /channels` into the `TrengoChannel` table, so the inbox can
// list them BY NAME with counts and a conversation can show WHICH line it is
// on. Idempotent on `trengoId`; safe to re-run. Mirrors `syncTrengoTeam`.

import { createId } from '@paralleldrive/cuid2'

import type { PrismaClient } from '@prisma/client'

import { createClientForAgent, type TrengoChannelResource } from './client'

/** Trengo channel `type` tag → our normalised channel kind. Unknown types
 *  (facebook, telegram, voice, …) keep a null kind — the channel still shows
 *  by name, just without one of our four typed icons. */
const TYPE_TO_KIND: Record<string, 'whatsapp' | 'sms' | 'email' | 'web_chat'> = {
  WA_BUSINESS: 'whatsapp',
  WHATSAPP: 'whatsapp',
  SMS: 'sms',
  EMAIL: 'email',
  CHAT: 'web_chat',
  WEB_CHAT: 'web_chat',
}

export function normaliseTrengoChannel(raw: unknown): {
  trengoId: number
  name: string | null
  trengoType: string | null
  channelType: 'whatsapp' | 'sms' | 'email' | 'web_chat' | null
} | null {
  if (raw === null || typeof raw !== 'object') return null
  const c = raw as TrengoChannelResource
  if (typeof c.id !== 'number') return null
  const name = typeof c.name === 'string' && c.name.trim() !== '' ? c.name.trim() : null
  const trengoType = typeof c.type === 'string' && c.type.trim() !== '' ? c.type.trim() : null
  const channelType = trengoType ? (TYPE_TO_KIND[trengoType.toUpperCase()] ?? null) : null
  return { trengoId: c.id, name, trengoType, channelType }
}

export interface SyncChannelsResult {
  synced: number
}

/**
 * Pull the Trengo channel list and upsert the `TrengoChannel` mirror through
 * the calling agent's own token. Returns a count. Throws on token/API error so
 * the caller can surface it. Also denormalises the latest channel NAME onto any
 * conversation already pointing at that channel id (so older rows show the name
 * once the mirror is first synced).
 */
export async function syncTrengoChannels(
  db: PrismaClient,
  agentId: string,
  requestId: string,
): Promise<SyncChannelsResult> {
  const client = await createClientForAgent({
    agentId,
    requestId,
    purpose: 'trengo.sync_channels',
  })
  const rows = await client.listChannels()

  let synced = 0
  for (const raw of rows) {
    const ch = normaliseTrengoChannel(raw)
    if (!ch) continue
    await db.trengoChannel.upsert({
      where: { trengoId: ch.trengoId },
      create: {
        id: createId(),
        trengoId: ch.trengoId,
        name: ch.name,
        trengoType: ch.trengoType,
        channelType: ch.channelType,
      },
      update: {
        name: ch.name,
        trengoType: ch.trengoType,
        channelType: ch.channelType,
      },
    })
    // Backfill the denormalised name onto conversations already on this channel
    // (blanks first; refresh if the channel was renamed in Trengo).
    if (ch.name) {
      await db.conversation.updateMany({
        where: { trengoChannelId: ch.trengoId },
        data: { trengoChannelName: ch.name },
      })
    }
    synced += 1
  }
  return { synced }
}
