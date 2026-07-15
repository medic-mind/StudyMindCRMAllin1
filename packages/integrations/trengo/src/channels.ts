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

/** Machine-y Trengo type tags that are never a real channel name regardless
 *  of the channel's own type ("Wa_business" six times over is not a rail). */
const ALWAYS_JUNK_TAGS = new Set([
  'wa_business',
  'web_chat',
  'webchat',
  'help_center',
  'helpcenter',
  'voip',
])

function foldTag(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '')
}

/**
 * Null out "names" that are really just the channel TYPE tag — they carry
 * zero identity. Two tiers so a channel GENUINELY named e.g. "Facebook" is
 * kept: unambiguous machine tags are always junk; generic words ("Email",
 * "Sms", "Chat", "Whatsapp") are junk only when they match the channel's OWN
 * type tag (an email line named "Email" says nothing; a WhatsApp line an
 * operator chose to call "Email" — unlikely but legal — is preserved).
 */
export function cleanChannelName(
  raw: string | null | undefined,
  ownTypeTag?: string | null,
): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const folded = foldTag(trimmed)
  if (ALWAYS_JUNK_TAGS.has(folded)) return null
  if (ownTypeTag) {
    const type = foldTag(ownTypeTag)
    if (folded === type) return null
    // "Whatsapp" on a WA_BUSINESS line is the same non-name; likewise the
    // chat/web_chat spellings of the widget.
    if (type === 'wa_business' && folded === 'whatsapp') return null
    const chatTags = new Set(['chat', 'web_chat', 'webchat'])
    if (chatTags.has(type) && chatTags.has(folded)) return null
  }
  return trimmed
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
  // Trengo spells the human label differently across versions; take the first
  // candidate that carries real identity (a configured name, else the line's
  // phone/username/email) — never a bare type tag.
  const trengoType = typeof c.type === 'string' && c.type.trim() !== '' ? c.type.trim() : null
  const candidates = [c.name, c.title, c.display_name, c.username, c.phone, c.phone_number, c.email]
  let name: string | null = null
  for (const cand of candidates) {
    const cleaned = cleanChannelName(typeof cand === 'string' ? cand : null, trengoType)
    if (cleaned) {
      name = cleaned
      break
    }
  }
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
