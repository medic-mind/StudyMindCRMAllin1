-- Manual triage state for the missed-calls workspace (CLAUDE.md §10). The
-- "called back" status is derived (a later outbound call to the same number),
-- never stored; this row records only the human override — `actioned` (handled
-- another way) or `dismissed` (spam / ignore) — so it survives re-derivation
-- and filters the workspace. Keyed on the Aircall call id (stringified).
--
-- Forward-only (CLAUDE.md §19); new table, no impact on existing rows.

CREATE TABLE "MissedCallReview" (
    "aircallCallId" TEXT NOT NULL,
    "status"        TEXT NOT NULL,
    "note"          TEXT,
    "reviewedById"  TEXT,
    "reviewedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MissedCallReview_pkey" PRIMARY KEY ("aircallCallId")
);

CREATE INDEX "MissedCallReview_status_idx" ON "MissedCallReview"("status");
