-- Call summary on a board card (slice B).
--
-- Adds the InteractionType enum values used when an agent records a call
-- summary on a card and when they fan it out to Slack / Trengo / email.
-- Both writes persist as Interactions on the backing Contact so they appear
-- in the customer's history. Forward-only per CLAUDE.md §19; Postgres enum
-- additions are append-only.

ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'call_summary';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'call_summary_sent';
