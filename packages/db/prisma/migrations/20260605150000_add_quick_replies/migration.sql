-- ADR 0020 Phase 6h — canned / quick replies. Saved message snippets an agent
-- inserts into a conversation reply. Shared team-wide (ownerUserId null);
-- the column is retained for a future personal scope.
--
-- Forward-only (CLAUDE.md §19); new table, no impact on existing rows.

CREATE TABLE "QuickReply" (
    "id"          TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "body"        TEXT NOT NULL,
    "channel"     TEXT,
    "ownerUserId" TEXT,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "archivedAt"  TIMESTAMP(3),

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuickReply_archivedAt_sortOrder_idx" ON "QuickReply"("archivedAt", "sortOrder");
CREATE INDEX "QuickReply_ownerUserId_idx" ON "QuickReply"("ownerUserId");
