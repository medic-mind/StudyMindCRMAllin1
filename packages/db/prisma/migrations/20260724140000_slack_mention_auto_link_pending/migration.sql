-- Self-heal for auto-dismissed Slack mentions (§12). When a mention carries an
-- identity signal (a name / email / phone) that the matcher couldn't resolve to
-- a contact yet — usually because that customer isn't in the CRM — it is
-- auto-dismissed AND flagged `autoLinkPending`. A background + request-time pass
-- re-runs the matcher over these and files the mention on the customer's
-- timeline the moment they are added to the CRM, then clears the flag. The row
-- stays resolved throughout, so it never re-enters the human tray.
-- Forward-only, additive, idempotent (CLAUDE.md §19).

ALTER TABLE "UnassignedSummary"
  ADD COLUMN IF NOT EXISTS "autoLinkPending" BOOLEAN NOT NULL DEFAULT false;

-- Keyset paging by the self-heal pass over pending rows.
CREATE INDEX IF NOT EXISTS "UnassignedSummary_autoLinkPending_id_idx"
  ON "UnassignedSummary" ("autoLinkPending", "id");
