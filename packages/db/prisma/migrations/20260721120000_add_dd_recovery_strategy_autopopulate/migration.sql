-- Direct Debit recovery: per-case recovery GOAL (ADR 0045 amendment).
--
-- Operators asked for an explicit choice per recovery case: are we trying to
-- get the customer back onto a payment plan (send a re-signup link) or are we
-- demanding the full outstanding balance now? This drives the automated-chase
-- send gate: `resend_link` needs a pasted re-signup link before anything sends;
-- `demand_full` chases for the full amount and needs no link.
--
-- Forward-only (§19): additive nullable-with-default column, safe to deploy
-- ahead of the code that reads it. Existing cases default to the gentler
-- re-signup goal.

ALTER TABLE "DirectDebitCase"
  ADD COLUMN IF NOT EXISTS "recoveryStrategy" TEXT NOT NULL DEFAULT 'resend_link';
