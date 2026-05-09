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

export interface SlackClient {
  readonly baseUrl: string
  chatPostMessage(input: SlackChatPostMessageInput): Promise<SlackChatPostMessageResult>
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

  return {
    baseUrl,
    async chatPostMessage(input) {
      return call<SlackChatPostMessageResult>('/chat.postMessage', input)
    },
  }
}
