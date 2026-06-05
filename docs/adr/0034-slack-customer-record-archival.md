# ADR 0034: Slack customer mentions are archived as a categorised internal record

- Status: Accepted
- Date: 2026-06-05
- Extends the existing Slack summary parser (CLAUDE.md §12, §18).

## Context

Slack retains messages for ~90 days on our plan. Staff discuss customers in
public channels, and that context is lost when it ages out. We want a permanent
internal record of any Slack message that references a customer — searchable on
the customer's timeline long after Slack has dropped it — and sorted by the kind
of matter it concerns.

The CRM already AI-parses messages in watched channels (`slack/event.received`)
and writes a `slack_summary` Interaction on the matched Contact when confidence
≥ 0.7. But it stored only the AI *summary* (plus sentiment / next action) — not
the original message — and had no category. The view-model (`SlackMention`)
already exposed `messageText` / `senderName` / `permalink`, but nothing wrote
them.

## Decision

Extend the existing flow rather than build a new pipeline:

1. **Archive the original message.** The `slack_summary` Interaction payload now
   stores `messageText` (the original text), `senderName`, `channelId`, and
   (backfill) `permalink`. This is the durable record — it lives in our Postgres
   (and the 7-year email-class retention bucket), so it survives Slack's 90-day
   window. Written by both the live handler (`jobs.ts`) and the 90-day
   first-connect backfill (`backfill.ts`).
2. **AI categorisation.** `slackSummarySchema` gains a `category`
   (billing · scheduling · feedback · complaint · academic · logistics · sales ·
   general); prompt version bumped to `2026-06-05.1` and eval fixtures updated
   (§18.3). Stored in the payload and surfaced as a chip on the contact's Slack
   section.
3. **Surfacing.** `SlackMention` exposes `category`; the contact page Slack
   section renders the category, the original message, sentiment, and next
   action.

Matching stays conservative (§3, §12): high-confidence email/phone matches
attach to the Contact; everything else lands in the unassigned-summaries tray
for a human — we never auto-create or guess.

## Consequences

- A customer's Slack history is preserved + sortable on their timeline,
  independent of Slack retention.
- No new tables or dependencies — a payload + AI-schema extension over the
  existing parser. The prompt change ships through the eval harness.
- Name-only references (no email/phone) still go to the tray rather than
  auto-attaching; widening match coverage safely is a possible follow-up.
