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
