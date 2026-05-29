-- Move Company from a fixed Postgres enum to an admin-editable table so the
-- team can add / rename / recolour brands from Settings without a code
-- change. CLAUDE.md §4, §19 (enum removals are usually a two-PR shadow-column
-- dance — here we keep it one-PR because the previous enum column had only
-- shipped two days ago and any existing tags map cleanly).

-- 1. Add the new FK column (still nullable, no FK yet so the backfill works
--    before the Company table exists).
ALTER TABLE "Contact" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Family"  ADD COLUMN "companyId" TEXT;

-- 2. Backfill from the old enum values to stable seed ids. The matching
--    Company rows are inserted below with the same ids.
UPDATE "Contact" SET "companyId" = 'cmp_seed_medic_mind'    WHERE "company" = 'medic_mind';
UPDATE "Contact" SET "companyId" = 'cmp_seed_oxbridge_mind' WHERE "company" = 'oxbridge_mind';
UPDATE "Contact" SET "companyId" = 'cmp_seed_study_mind'    WHERE "company" = 'study_mind';

UPDATE "Family" SET "companyId" = 'cmp_seed_medic_mind'    WHERE "company" = 'medic_mind';
UPDATE "Family" SET "companyId" = 'cmp_seed_oxbridge_mind' WHERE "company" = 'oxbridge_mind';
UPDATE "Family" SET "companyId" = 'cmp_seed_study_mind'    WHERE "company" = 'study_mind';

-- 3. Drop the old enum columns + indexes.
DROP INDEX IF EXISTS "Contact_company_idx";
DROP INDEX IF EXISTS "Family_company_idx";
ALTER TABLE "Contact" DROP COLUMN "company";
ALTER TABLE "Family"  DROP COLUMN "company";

-- 4. Drop the now-unused enum type so we can reuse the name for the new
--    table's row type (Postgres auto-creates a type per table).
DROP TYPE "Company";

-- 5. Create the Company table.
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");
CREATE INDEX "Company_archivedAt_idx" ON "Company"("archivedAt");

-- 6. Seed the three default brands so existing tags resolve. Ops can rename
--    / recolour / archive them from Settings → Companies after the deploy;
--    they can also add new ones with new cuids.
INSERT INTO "Company" ("id", "name", "slug", "color", "updatedAt") VALUES
    ('cmp_seed_medic_mind',    'Medic Mind',    'medic-mind',    '#e11d48', CURRENT_TIMESTAMP),
    ('cmp_seed_oxbridge_mind', 'Oxbridge Mind', 'oxbridge-mind', '#0284c7', CURRENT_TIMESTAMP),
    ('cmp_seed_study_mind',    'Study Mind',    'study-mind',    '#9333ea', CURRENT_TIMESTAMP);

-- 7. Hook the FKs up + index.
ALTER TABLE "Contact"
    ADD CONSTRAINT "Contact_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Family"
    ADD CONSTRAINT "Family_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");
CREATE INDEX "Family_companyId_idx"  ON "Family"("companyId");
