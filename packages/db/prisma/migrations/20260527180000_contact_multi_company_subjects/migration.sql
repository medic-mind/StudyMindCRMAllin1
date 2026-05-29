-- Contact: multi-company tagging, tutoring subjects, diversified profile.
-- CLAUDE.md §4 (companies admin-editable), §19 (additive forward-only;
-- the dropped Contact.companyId column had only just shipped a day ago,
-- so the backfill into ContactCompany is the migration path).

-- 1. New ContactCompany join (many-to-many).
CREATE TABLE "ContactCompany" (
    "contactId"   TEXT NOT NULL,
    "companyId"   TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "ContactCompany_pkey" PRIMARY KEY ("contactId", "companyId")
);
CREATE INDEX "ContactCompany_companyId_idx" ON "ContactCompany"("companyId");

ALTER TABLE "ContactCompany"
    ADD CONSTRAINT "ContactCompany_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;
ALTER TABLE "ContactCompany"
    ADD CONSTRAINT "ContactCompany_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE;

-- 2. Backfill from the existing single-FK Contact.companyId.
INSERT INTO "ContactCompany" ("contactId", "companyId")
SELECT id, "companyId" FROM "Contact" WHERE "companyId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3. Drop the old single-FK column.
ALTER TABLE "Contact" DROP CONSTRAINT IF EXISTS "Contact_companyId_fkey";
DROP INDEX IF EXISTS "Contact_companyId_idx";
ALTER TABLE "Contact" DROP COLUMN "companyId";

-- 4. ContactSubject join, hooked to the existing Subject table that boards
--    already populate (no separate "academic subject" silo).
CREATE TABLE "ContactSubject" (
    "contactId"   TEXT NOT NULL,
    "subjectId"   TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "ContactSubject_pkey" PRIMARY KEY ("contactId", "subjectId")
);
CREATE INDEX "ContactSubject_subjectId_idx" ON "ContactSubject"("subjectId");

ALTER TABLE "ContactSubject"
    ADD CONSTRAINT "ContactSubject_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE;
ALTER TABLE "ContactSubject"
    ADD CONSTRAINT "ContactSubject_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE;

-- 5. Subject archive flag so the picker can hide retired ones without
--    breaking historical card / contact links.
ALTER TABLE "Subject" ADD COLUMN "archivedAt" TIMESTAMP(3);
CREATE INDEX "Subject_archivedAt_idx" ON "Subject"("archivedAt");

-- 6. Diversified contact profile fields.
CREATE TYPE "ContactPreferredContactMethod" AS ENUM (
    'email', 'phone', 'whatsapp', 'any'
);
ALTER TABLE "Contact"
    ADD COLUMN "preferredContactMethod" "ContactPreferredContactMethod",
    ADD COLUMN "timezone"               TEXT,
    ADD COLUMN "referralSource"         TEXT,
    ADD COLUMN "examTarget"             TEXT;
