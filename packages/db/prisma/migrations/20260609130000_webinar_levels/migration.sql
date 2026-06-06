-- Generalise the webinar level/type into an operator-managed catalogue so the
-- "New class" workflow offers GCSE, A-Level, UCAT, GAMSAT, … and admins can add
-- more (CLAUDE.md §47). WebinarClass.level becomes a free string handle (the
-- WebinarLevel enum is retained, now orphaned, per forward-only §19). The five
-- existing values ('gcse'/'a_level') convert cleanly to text.

-- 1. Convert WebinarClass.level from the enum to text.
ALTER TABLE "WebinarClass" ALTER COLUMN "level" TYPE TEXT USING "level"::text;

-- 2. Level/type catalogue. Seeded by prisma/seed-webinar.ts.
CREATE TABLE "WebinarLevelOption" (
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

    CONSTRAINT "WebinarLevelOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarLevelOption_handle_key" ON "WebinarLevelOption"("handle");
CREATE INDEX "WebinarLevelOption_archivedAt_idx" ON "WebinarLevelOption"("archivedAt");
