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
≥ 0.7. But it stored only the AI _summary_ (plus sentiment / next action) — not
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

---

## Amendment (2026-06-16): automate the triage — auto-link, don't park

**Problem.** In practice _zero_ customers were showing Slack mentions. Two
causes: (1) the shared matcher only resolved an exact **first + last** name, so
the common Slack shorthand ("spoke to Aanya about UCAT") never matched and parked
in the tray; (2) once a message parked in `UnassignedSummary`, **nothing ever
retried it** — so even mentions of contacts that were later created, or that a
human would resolve instantly, sat in the tray forever. The tray was a dead-end,
not a queue.

**Decision — make linking automatic, AI-cheap, and self-healing.**

1. **Smarter shared matcher** (`packages/core/src/contact/match-candidate.ts`,
   reused by every consumer). The name pass now also auto-links an **unambiguous
   single token / surname / whole-name-held-in-one-column** — exactly one contact
   carrying it as a first OR last name. Still unambiguous-only: two same-named
   people park (§3). This is free (DB only) and is the single biggest recall win.

2. **Lower the live confidence gate** to 0.5 (`SLACK_MATCH_THRESHOLD`). The AI's
   self-confidence was never the real safety — the matcher's unambiguous rule is —
   so we attempt the match on more extractions and let ambiguity protect us.

3. **Recurring auto-relink job** `slack/relink-unassigned` (every 30 min,
   `packages/integrations/slack/src/relink.ts`). It re-runs the smarter matcher
   over every open `UnassignedSummary`, auto-links the unambiguous ones, and
   resolves the row. It is **free**: it reuses the AI extraction already stored on
   the row plus a deterministic email/phone scan of the original text — it never
   calls the AI again. This drains the existing backlog and self-heals new parks
   (e.g. a contact created after the mention). Idempotent (dedupe on the archived
   Slack `ts`); ambiguous rows stay in the tray for a human.

4. **Diagnostic.** The Slack webhook `GET` now reports `aiConfigured`, so it's
   obvious when name-only mentions can't be extracted because no AI key is set
   (Gemini/OpenAI). Re-running the 90-day backfill after setting a key reclassifies
   history; the relink job then auto-links it.

**Cost.** Effectively nil. The matcher and relink job are pure DB work; the only
AI spend is the existing one mini-tier extraction per _new, human_ Slack message
(bot posts are skipped, ADR 0039). No new tables or dependencies.

**Consequences.**

- Most mentions now auto-link at ingest; the rest auto-link within ~30 min as
  soon as they resolve to one contact. The tray holds only genuinely ambiguous
  or unmatchable references — a real triage queue, not a graveyard.
- Slightly more aggressive auto-linking; still never auto-creates a contact and
  never resolves an ambiguous candidate (§3, §41.1).
