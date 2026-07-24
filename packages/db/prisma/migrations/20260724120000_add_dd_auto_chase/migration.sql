-- Direct Debit recovery: operator-level AUTOMATIC chasing (ADR 0045 amendment).
--
-- The recovery system opened a case for every cancelled/underpaid Direct Debit
-- but left it un-armed — a human had to paste a re-signup link and flip the
-- channel switches PER CASE before anything sent. For a bulk list that is
-- untenable, so "automated reminders" never actually ran.
--
-- These settings let the operator turn on automatic chasing ONCE, globally: the
-- hourly engine then arms every new (un-touched) case with the enabled channels
-- + the single global re-signup link and schedules the first message. The
-- operator-authorised money-send exception (§3), gated by `autoChaseEnabled`
-- (default false — nothing auto-sends until it is turned on).
--
-- Forward-only (§19): additive nullable / defaulted columns, safe to deploy
-- ahead of the code that reads them.

ALTER TABLE "DdRecoverySettings"
  ADD COLUMN IF NOT EXISTS "autoChaseEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "autoChaseSetupLinkUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "autoChaseEmail" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "autoChaseSms" BOOLEAN NOT NULL DEFAULT false;
