-- GDPR right-to-erasure (Article 17) support on Contact.
-- `erasureScheduledAt` marks a contact soft-deleted with a 30-day grace window;
-- the daily `compliance/erase-due-records` job crypto-shreds + anonymises the
-- record once the window passes. `erasedAt` is stamped the moment the personal
-- data is destroyed (immediate erasure sets it directly). Both null for a
-- normal contact. Forward-only, additive, defensively idempotent (CLAUDE.md §19).

ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "erasureScheduledAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "erasedAt" TIMESTAMP(3);

-- The erasure job scans for due, not-yet-erased contacts; index that predicate.
CREATE INDEX IF NOT EXISTS "Contact_erasureScheduledAt_idx"
  ON "Contact" ("erasureScheduledAt");
