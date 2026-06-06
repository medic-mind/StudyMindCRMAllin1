-- Operator-managed catalogue of webinar subjects (CLAUDE.md §47). The "New
-- class" workflow reads this for its Subject dropdown and admins can add new
-- subjects without a code change. Forward-only; new table, no impact on
-- existing rows. The five live subjects are seeded by prisma/seed-webinar.ts.

CREATE TABLE "WebinarSubjectOption" (
    "id"          TEXT NOT NULL,
    "handle"      TEXT NOT NULL,
    "label"       TEXT NOT NULL,
    "aliases"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sortOrder"   INTEGER NOT NULL DEFAULT 100,
    "archivedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "WebinarSubjectOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarSubjectOption_handle_key" ON "WebinarSubjectOption"("handle");
CREATE INDEX "WebinarSubjectOption_archivedAt_idx" ON "WebinarSubjectOption"("archivedAt");
