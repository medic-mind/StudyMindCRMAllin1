-- Direct Debit recovery: operator-level AUTOMATIC chasing (ADR 0045 amendment).
--
-- The recovery system opened a case for every cancelled/underpaid Direct Debit
-- but left it un-armed — a human had to paste a re-signup link and flip the
-- channel switches PER CASE before anything sent. For a bulk list that is
-- untenable, so "automated reminders" never actually ran.
--
-- Automatic chasing is ON by default (operator decision): the hourly engine
-- arms every new (un-touched) case with the enabled channels + the single
-- global re-signup link and schedules the first message. The only input the
-- operator supplies is that link — until it is set, an armed case still sends
-- nothing. `DD_AUTO_CHASE=off` pauses the whole thing.
--
-- Forward-only (§19): additive nullable / defaulted columns, safe to deploy
-- ahead of the code that reads them. The default applies to any existing
-- settings row, so automatic chasing is live the moment a link exists.

ALTER TABLE "DdRecoverySettings"
  ADD COLUMN IF NOT EXISTS "autoChaseEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "autoChaseSetupLinkUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "autoChaseEmail" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "autoChaseSms" BOOLEAN NOT NULL DEFAULT false;
