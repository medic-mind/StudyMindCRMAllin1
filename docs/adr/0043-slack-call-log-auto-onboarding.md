# ADR 0043 — Slack call-log auto-onboarding, own-brand guard, join-all-channels

Date: 2026-07-18
Status: Accepted

## Context

The operator's diagnosis of "Slack still isn't filing messages onto individual
customers" surfaced three distinct causes:

1. **The token's bot was only in one channel.** The workspace has a different
   app invited everywhere; `@study_mind_crm` (whose token the CRM holds) was a
   member of a single channel, so every pull/webhook/backfill saw only that
   channel. Nothing in the product could fix membership — only a per-channel
   `/invite` or the `channels:join` scope the app already holds.
2. **Customers named in call logs often don't exist in the CRM yet.** The
   ingest (ADR 0034) deliberately never created contacts from Slack (§11), so
   phone-bearing call summaries for new customers parked in the triage tray
   instead of becoming individual records — exactly the "names but no CRM
   entries" the operator reported.
3. **Own brands hijack matching.** Every summary ends with the brand
   ("… Medic Mind"), and bodies quote internal emails (info@medicmind.co.uk).
   Those are name/email candidates like any other and could file a mention
   onto a brand B2B account or become a created contact's identity.

## Decision

**Join-all.** A CEO/Senior-Manager "Join all public channels" action
(Settings → Integrations → Slack) walks `conversations.list` and
`conversations.join`s every public channel the bot is not yet in — the
operator's explicit bulk consent, auditable (`slack.channels_joined`),
replacing dozens of manual `/invite`s. Private channels still require a human
invite (Slack requires it); §12's invite-is-consent principle is amended to
"invite or operator-confirmed bulk join".

**Auto-onboarding.** A message whose OWN text carries a diallable phone that
matches no contact auto-creates the customer through the shared call resolver
(`resolveOrCreateContactForCall`, §10) — the same standard as an Aircall call
or a web enquiry: a call summary records a genuine human touch. The phone is
the gate: name-only chatter never creates anybody, shared lines park for a
human, and matching an existing contact fills blanks only. The name prefers
the call-log header (text before the number — works for lower-case names the
proper-noun extractor cannot see), else the first non-brand extracted
candidate; the E.164 normaliser fixes the team's "+44 07818…" paste. Applied
on every ingest path (webhook, pull, backfill, relink — the relink pass also
drains the existing parked backlog into real records).

**Own-brand guard.** Brand names (live `Company` catalogue + seeds) and brand
email domains (`BrandDomainRule` + seeds) are filtered out of match
candidates on every path, cached in-process (~10 min).

## Consequences

- One press of "Join all public channels" + a 90-day backfill gives full
  workspace coverage; the health panel's "Reading N channels" confirms it.
- Slack call summaries now produce individual customer records with the
  message on their timeline, deduped against leads/Aircall/Trengo by the
  shared phone key. Contacts created this way are `kind: unclassified`,
  `referralSource: "Slack call summary"`, audited `contact.created`.
- §11's "never auto-create from Slack" becomes "never auto-create WITHOUT a
  diallable phone" — the spam-route guard stands (spam has no call log).
- The 90-day import also moved to one Inngest step per page (per-message
  steps exceeded Inngest's step budget on large workspaces and killed the
  run) with delta-based progress every 10 messages, fixing both the silent
  mid-import death and the "stuck at 0" display.
