-- Prospective cancelled/underpaid plan tracking (ADR 0038, seventh amendment).
-- The CRM should only surface plans that cancel from go-live (June 2026) onward;
-- the ~702 plans already cancelled/finished are handled on another system and
-- were creating noise. Snapshot the existing terminal set as ignored so they
-- drop out of the Issues tab + stop raising discrepancies. Going forward, only
-- a plan first seen active that later cancels is flagged (set at create-time in
-- upsertGcSubscriptionMirror).
ALTER TABLE "GcSubscription" ADD COLUMN "shortfallIgnored" BOOLEAN NOT NULL DEFAULT false;
UPDATE "GcSubscription" SET "shortfallIgnored" = true WHERE "status" IN ('cancelled', 'finished');
