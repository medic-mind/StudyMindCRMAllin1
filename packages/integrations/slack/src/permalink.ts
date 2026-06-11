// Pure Slack permalink construction. The Events API payload does not carry a
// permalink (only conversations.history does), so live events build the
// canonical archives URL — slack.com redirects it into the workspace. Thread
// replies link into the thread so the click lands on the right message.

export function buildSlackPermalink(
  channelId: string,
  ts: string,
  threadTs?: string | null,
): string {
  const base = `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`
  return threadTs && threadTs !== ts
    ? `${base}?thread_ts=${threadTs}&cid=${channelId}`
    : base
}
