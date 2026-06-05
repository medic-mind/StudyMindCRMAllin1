# ADR 0033: Slack notification routing is operator-configured

- Status: Accepted
- Date: 2026-06-05
- Builds on the `SlackChannelOption` catalogue (Settings → Slack channels).

## Context

The CRM posts several kinds of message to Slack — call summaries, Google Voice
manual-review alerts, Direct Debit defaulter summaries, the weekly cost digest,
and security/UEBA alerts. Each destination was hardwired to an env var
(`SLACK_FINOPS_CHANNEL_ID`, `SLACK_INCIDENTS_CHANNEL_ID`, …). Changing where a
kind of message goes — or muting it — meant an env/redeploy. Operators want to
manage this from the app ("send these messages to that channel") without
reprogramming.

## Decision

A small **routing table** maps a code-defined *topic* to a channel:

- **`SlackRoute`** (`topic` unique, `channelOptionId?` → `SlackChannelOption`,
  `enabled`). One row per topic; absent row = use the fallback.
- **`SLACK_TOPICS`** (`packages/core/src/slack/topics.ts`) is the code registry
  of routable message kinds (`call_summary`, `google_voice`,
  `finance_dd_defaulters`, `cost_summary`, `security_alerts`, `general_alert`).
  Adding a brand-new *kind* of message is still a code change (it maps to real
  sending code); **routing an existing one is not**.
- **Resolver** `resolveTopicChannelId(db, topic, fallbackEnvChannelId?)`
  (`packages/core/src/slack/route-resolver.ts`, takes `db` so integrations and
  web boundaries share it): route channel → caller's env fallback → default
  `SlackChannelOption` → `SLACK_ALERTS_CHANNEL_ID`. `enabled=false` → null
  (muted); every sender already treats null as "skip".
- **Settings UI** — "Where notifications go" on `/settings/slack-channels`
  (Manager+): per-topic channel dropdown + on/off, audited `slack_route.updated`.

The Google Voice handler and the dd-defaulters / cost-summary / UEBA boundaries
now resolve via the topic route (with their existing env var as the fallback),
so existing behaviour is unchanged until an admin sets a route.

## Consequences

- Operators retarget or mute any wired notification from the app; no redeploy.
- Forward-only migration; no seed, so deployments behave exactly as before until
  a route is set.
- Reuses the channel catalogue + the audited settings pattern; no new deps.
