-- Shared, staff-curated label catalogue + the BusinessAccount ↔ AccountLabel
-- junction. Free-form colour-coded tags applied to B2B accounts (schools +
-- B2B partners). Distinct from `Label` (board cards, ADR 0018) and `Company`
-- (brand tags) — those carry their own semantics.
--
-- Forward-only (CLAUDE.md §19); two new tables, no impact on existing rows.

CREATE TABLE "AccountLabel" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "color"       TEXT,
    "description" TEXT,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    "archivedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "AccountLabel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountLabel_name_key" ON "AccountLabel"("name");
CREATE INDEX "AccountLabel_archivedAt_idx" ON "AccountLabel"("archivedAt");

CREATE TABLE "BusinessAccountLabel" (
    "accountId"   TEXT NOT NULL,
    "labelId"     TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "BusinessAccountLabel_pkey" PRIMARY KEY ("accountId", "labelId")
);

CREATE INDEX "BusinessAccountLabel_labelId_idx" ON "BusinessAccountLabel"("labelId");

ALTER TABLE "BusinessAccountLabel"
    ADD CONSTRAINT "BusinessAccountLabel_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "BusinessAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessAccountLabel"
    ADD CONSTRAINT "BusinessAccountLabel_labelId_fkey"
    FOREIGN KEY ("labelId") REFERENCES "AccountLabel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
