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

/**
 * Fully-automated Slack tray (operator direction, 2026-07). ON by default: the
 * relink cron must leave NO parked mention waiting for a human — every open row
 * is either auto-linked / auto-onboarded to a contact OR auto-dismissed, so the
 * `/inbox/slack-mentions` tray drains to zero on its own (the original intent).
 * A substantive-but-nameless mention the matcher can't resolve is DISMISSED
 * (retained + reversible, not deleted) rather than parked. Set
 * `SLACK_TRAY_FULL_AUTO=off` to restore the old "keep nameless rows for a human"
 * behaviour (§3).
 */
export function slackTrayFullAuto(): boolean {
  const v = (process.env['SLACK_TRAY_FULL_AUTO'] ?? '').trim().toLowerCase()
  return v !== 'off' && v !== 'false' && v !== '0' && v !== 'no'
}
