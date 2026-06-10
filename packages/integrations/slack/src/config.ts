// Slack channel read scope. CLAUDE.md §12: by default the CRM reads every
// channel the bot has been /invited to — Slack only delivers channel events
// for conversations the bot is a member of, so the invite IS the per-channel
// consent gate (never the whole workspace). Setting SLACK_WATCHED_CHANNELS
// (C111,C222 comma separated) narrows that to an explicit allowlist.

export function getWatchedChannels(): readonly string[] {
  const raw = process.env['SLACK_WATCHED_CHANNELS']
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function isWatchedChannel(channelId: string): boolean {
  const list = getWatchedChannels()
  // No allowlist configured → accept any channel the event arrives for. The
  // bot's channel membership (the /invite) is the gate; Slack does not send
  // message.channels events for channels the bot is not in.
  if (list.length === 0) return true
  return list.includes(channelId)
}

/** The single channel where outbound bot alerts post. CLAUDE.md §12. */
export function getAlertsChannelId(): string | null {
  return process.env['SLACK_ALERTS_CHANNEL_ID'] ?? null
}
