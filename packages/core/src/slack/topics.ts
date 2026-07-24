// Slack notification topics — the code-defined set of message *kinds* the CRM
// can send to Slack. Each topic can be pointed at any configured channel (or
// muted) from Settings → Slack channels → "Where notifications go", so changing
// where a kind of message goes needs no code change (the routing layer; ADR
// 0033). Adding a brand-new *kind* of message is still a code change (it
// corresponds to real sending code), but routing an existing one is not.

export const SLACK_TOPICS = [
  {
    key: 'call_summary',
    label: 'Call summaries',
    description:
      'Where EVERY call summary recorded in the CRM is posted (your #callsummaries channel) — self-send and VA hand-off alike (ADR 0039). The post is flagged as already sent to the customer, or as needing VA action.',
    // Well-known channel NAME this topic is meant for. When no explicit route
    // is configured, the sender auto-discovers the Slack channel with this name
    // and wires it up (see resolveTopicChannelWithDiscovery) instead of quietly
    // dumping the message into the generic default channel.
    defaultChannelName: 'callsummaries',
  },
  {
    key: 'complaint_call_summary',
    label: 'Complaint call summaries',
    description:
      'Where a complaint LOGGED IN THE CRM is posted (your #complaintcallsummaries channel) — the structured summary (client details, the complaint, severity/category). The reverse of the Slack→CRM import, so logging a complaint here and typing one in Slack do the same thing.',
    defaultChannelName: 'complaintcallsummaries',
  },
  {
    key: 'google_voice',
    label: 'Google Voice alerts',
    description:
      'Voicemail / missed-call / text notifications ingested from Google Voice that need a human to follow up.',
  },
  {
    key: 'finance_dd_defaulters',
    label: 'Direct Debit defaulters',
    description: 'GoCardless defaulter summaries from the nightly finance scan.',
  },
  {
    key: 'cost_summary',
    label: 'Weekly cost summary',
    description: 'Month-to-date AI / infrastructure spend digest.',
  },
  {
    key: 'security_alerts',
    label: 'Security & access alerts',
    description: 'UEBA anomaly detections and KMS break-glass alerts.',
  },
  {
    key: 'general_alert',
    label: 'General alerts',
    description: 'Catch-all for any alert without its own dedicated route.',
  },
] as const

export type SlackTopicKey = (typeof SLACK_TOPICS)[number]['key']

export const SLACK_TOPIC_KEYS: SlackTopicKey[] = SLACK_TOPICS.map((t) => t.key)

export function isSlackTopic(key: string): key is SlackTopicKey {
  return (SLACK_TOPIC_KEYS as string[]).includes(key)
}

/**
 * The well-known Slack channel NAME a topic is meant to post to (null when the
 * topic has no canonical channel of its own). Used to auto-discover and wire up
 * the operator's channel by name when no explicit route is set — so complaint
 * summaries reach `#complaintcallsummaries` even before anyone touches Settings.
 */
export function getTopicDefaultChannelName(topic: SlackTopicKey): string | null {
  const entry = SLACK_TOPICS.find((t) => t.key === topic)
  return entry && 'defaultChannelName' in entry ? entry.defaultChannelName : null
}

/**
 * Normalise a Slack channel name for tolerant matching: drop a leading `#`,
 * lowercase, and strip every non-alphanumeric character. So `#Complaint-Call
 * Summaries`, `complaint_call_summaries` and `complaintcallsummaries` all
 * collapse to the same key. Slack channel names cannot contain spaces or most
 * punctuation, but pasted values and human variants do — matching must not care.
 */
export function normaliseSlackChannelName(name: string): string {
  return name
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** True when two Slack channel names refer to the same channel (normalised). */
export function slackChannelNameMatches(a: string, b: string): boolean {
  const na = normaliseSlackChannelName(a)
  const nb = normaliseSlackChannelName(b)
  return na.length > 0 && na === nb
}
