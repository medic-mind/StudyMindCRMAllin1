// Slack channel allowlist. CLAUDE.md §12: never workspace-wide; the watched
// channel list lives here and changes ship via PR, never via the Slack admin
// UI. Production set via SLACK_WATCHED_CHANNELS=C111,C222 (comma separated).

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
  if (list.length === 0) return false
  return list.includes(channelId)
}

/** The single channel where outbound bot alerts post. CLAUDE.md §12. */
export function getAlertsChannelId(): string | null {
  return process.env['SLACK_ALERTS_CHANNEL_ID'] ?? null
}
