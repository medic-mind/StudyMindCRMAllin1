// Slack Web API client. CLAUDE.md §12.
// One bot user posts to the agreed `#crm-alerts` channel only. No DMs.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

export const SLACK_API_BASE = 'https://slack.com/api' as const

export class SlackApiError extends Error {
  override readonly name = 'SlackApiError'
  constructor(
    public readonly endpoint: string,
    public readonly slackError: string,
  ) {
    super(`Slack API error on ${endpoint}: ${slackError}`)
  }
}

export interface SlackChatPostMessageInput {
  channel: string
  text: string
  blocks?: unknown[]
}

export interface SlackChatPostMessageResult {
  ok: boolean
  channel: string
  ts: string
}

/** One channel from `conversations.list` — the fields the picker needs. */
export interface SlackConversation {
  id: string
  name: string
  /** True when the bot has been /invited into the channel (it can post there). */
  isMember: boolean
  /** Private channels only list when the token has `groups:read`. */
  isPrivate: boolean
}

/** Who the configured token actually is (auth.test) — lets the UI say
 *  "invite @this-exact-bot" instead of a generic name, which catches the
 *  classic failure of inviting a different app than the one whose token the
 *  CRM holds. */
export interface SlackIdentity {
  botName: string | null
  teamName: string | null
}

export interface SlackClient {
  readonly baseUrl: string
  chatPostMessage(input: SlackChatPostMessageInput): Promise<SlackChatPostMessageResult>
  /**
   * List the workspace's channels (name + id + bot membership) so Settings →
   * Slack channels can offer a pick-by-name browser instead of hand-pasted
   * channel ids. Paginates internally (bounded); needs the `channels:read`
   * bot scope — without it Slack returns `missing_scope`, which surfaces as
   * a SlackApiError for the caller to map to a friendly "re-install with the
   * extra permission" message. Private channels are included when the token
   * also has `groups:read` (fails soft back to public-only when it doesn't);
   * they can always be added by id.
   */
  listChannels(): Promise<SlackConversation[]>
  /** The bot identity behind the configured token (auth.test, no scope
   *  needed). Null fields when Slack doesn't return them. */
  identity(): Promise<SlackIdentity>
  /** Resolve a Slack user id (U…) to their display name via `users.info`.
   *  Needs the `users:read` bot scope; the caller treats a failure as
   *  "keep the raw id". */
  getUserDisplayName(userId: string): Promise<string | null>
  /** Resolve a channel id (C…) to its #name via `conversations.info`. */
  getChannelName(channelId: string): Promise<string | null>
  /** The text of a thread's ROOT message (`conversations.replies`, first
   *  message). Lets a threaded reply that names no customer of its own inherit
   *  the customer from the message it replies to. Needs the `channels:history`
   *  bot scope (already required for the message events); a failure returns
   *  null so matching falls back to the reply alone. */
  getThreadParentText(channelId: string, threadTs: string): Promise<string | null>
}

export interface CreateSlackClientOptions {
  token?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export function createClient(opts: CreateSlackClientOptions = {}): SlackClient {
  const token = opts.token ?? process.env['SLACK_BOT_TOKEN']
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set')

  const baseUrl = opts.baseUrl ?? SLACK_API_BASE
  const fetchImpl = opts.fetchImpl ?? safeFetch

  async function call<T>(endpoint: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const parsed = (text ? JSON.parse(text) : {}) as { ok?: boolean; error?: string }
    if (!parsed.ok) {
      throw new SlackApiError(endpoint, parsed.error ?? `http_${res.status}`)
    }
    return parsed as T
  }

  // Read-style Web API methods (conversations.list etc.) take their arguments
  // as a query string, not a JSON body.
  async function get<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString()
    const res = await fetchImpl(`${baseUrl}${endpoint}?${qs}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    const text = await res.text()
    const parsed = (text ? JSON.parse(text) : {}) as { ok?: boolean; error?: string }
    if (!parsed.ok) {
      throw new SlackApiError(endpoint, parsed.error ?? `http_${res.status}`)
    }
    return parsed as T
  }

  return {
    baseUrl,
    async chatPostMessage(input) {
      return call<SlackChatPostMessageResult>('/chat.postMessage', input)
    },
    async listChannels() {
      interface Page {
        channels?: Array<{
          id?: string
          name?: string
          is_member?: boolean
          is_archived?: boolean
          is_private?: boolean
        }>
        response_metadata?: { next_cursor?: string }
      }
      async function listWith(types: string): Promise<SlackConversation[]> {
        const out: SlackConversation[] = []
        let cursor = ''
        // Bounded pagination: 10 pages × 200 = up to 2 000 channels, plenty
        // for any workspace this CRM serves and safe against a runaway loop.
        for (let page = 0; page < 10; page += 1) {
          const res = await get<Page>('/conversations.list', {
            types,
            exclude_archived: 'true',
            limit: '200',
            ...(cursor ? { cursor } : {}),
          })
          for (const ch of res.channels ?? []) {
            if (!ch.id || !ch.name || ch.is_archived) continue
            out.push({
              id: ch.id,
              name: ch.name,
              isMember: ch.is_member === true,
              isPrivate: ch.is_private === true,
            })
          }
          cursor = res.response_metadata?.next_cursor ?? ''
          if (!cursor) break
        }
        return out.sort((a, b) => a.name.localeCompare(b.name))
      }
      try {
        // Private channels the bot is in surface here too (needs groups:read).
        return await listWith('public_channel,private_channel')
      } catch (err) {
        if (err instanceof SlackApiError && err.slackError === 'missing_scope') {
          // groups:read absent — public channels still beat nothing.
          return listWith('public_channel')
        }
        throw err
      }
    },
    async identity() {
      const res = await call<{ user?: string; team?: string }>('/auth.test', {})
      return { botName: res.user ?? null, teamName: res.team ?? null }
    },
    async getUserDisplayName(userId) {
      const res = await get<{
        user?: { real_name?: string; name?: string; profile?: { display_name?: string } }
      }>('/users.info', { user: userId })
      const u = res.user
      const name = u?.profile?.display_name || u?.real_name || u?.name || null
      return name && name.trim() ? name.trim() : null
    },
    async getChannelName(channelId) {
      const res = await get<{ channel?: { name?: string } }>('/conversations.info', {
        channel: channelId,
      })
      const name = res.channel?.name ?? null
      return name && name.trim() ? name.trim() : null
    },
    async getThreadParentText(channelId, threadTs) {
      const res = await get<{ messages?: Array<{ text?: string }> }>('/conversations.replies', {
        channel: channelId,
        ts: threadTs,
        limit: '1',
        inclusive: 'true',
      })
      const text = res.messages?.[0]?.text ?? null
      return text && text.trim() ? text : null
    },
  }
}

// -----------------------------------------------------------------------------
// Channel resolution for ingestion (pull paths). "Everything the bot can read":
// the SLACK_WATCHED_CHANNELS allowlist when set, otherwise EVERY channel the bot
// is a member of (conversations.list → isMember). conversations.history only
// works on channels the bot has joined, so we filter to membership.
// -----------------------------------------------------------------------------

import { getWatchedChannels } from './config'

export async function listIngestChannelIds(
  opts: CreateSlackClientOptions = {},
): Promise<string[]> {
  const allow = getWatchedChannels()
  if (allow.length > 0) return [...allow]
  const client = createClient(opts)
  const channels = await client.listChannels()
  return channels.filter((c) => c.isMember).map((c) => c.id)
}
