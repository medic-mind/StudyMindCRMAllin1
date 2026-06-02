-- Manual triage state for the hours-risk system. The risk itself stays derived
-- (deriveHoursRisk, never persisted); this row records the human decision —
-- `flagged` (being chased) or `dismissed` (not a concern) — so it survives
-- re-derivation and drives the at-risk dashboard filters.
--
-- Forward-only (CLAUDE.md §19); one new table, no impact on existing rows.

CREATE TABLE "ContactRiskReview" (
    "contactId"     TEXT NOT NULL,
    "status"        TEXT NOT NULL,
    "note"          TEXT,
    "levelAtReview" TEXT,
    "reviewedById"  TEXT,
    "reviewedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactRiskReview_pkey" PRIMARY KEY ("contactId")
);

CREATE INDEX "ContactRiskReview_status_idx" ON "ContactRiskReview"("status");

ALTER TABLE "ContactRiskReview"
    ADD CONSTRAINT "ContactRiskReview_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
