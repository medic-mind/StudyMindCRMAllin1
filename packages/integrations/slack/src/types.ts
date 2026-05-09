// Domain-mapped types for Slack. CLAUDE.md §12.
//
// We only subscribe to message.channels on the agreed channel allowlist.
// Anything else is rejected at the route handler before we even parse.

export const SLACK_EVENT_NAMES = ['message.channels'] as const
export type SlackEventName = (typeof SLACK_EVENT_NAMES)[number]

export function isSlackEventName(value: string): value is SlackEventName {
  return (SLACK_EVENT_NAMES as readonly string[]).includes(value)
}

/** Inner Slack event payload for a message in a watched channel. */
export interface SlackMessageEvent {
  type: 'message'
  channel: string
  channel_type?: string
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  subtype?: string
}

/** Outer Events API envelope. */
export interface SlackEventEnvelope {
  type: 'event_callback'
  /** Workspace event id; we use this for ProviderEvent dedupe. */
  event_id: string
  event_time: number
  team_id: string
  api_app_id: string
  event: SlackMessageEvent
}

/** URL verification handshake — Slack sends this once to confirm the URL. */
export interface SlackUrlVerification {
  type: 'url_verification'
  token: string
  challenge: string
}

export type SlackInbound = SlackEventEnvelope | SlackUrlVerification
