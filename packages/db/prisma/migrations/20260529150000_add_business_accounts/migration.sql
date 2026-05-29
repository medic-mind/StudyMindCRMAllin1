-- B2B accounts — schools + partnership organisations we track. Mirrors the
-- shape of `Company` but for outward-facing B2B relationships, with extra
-- fields (status lifecycle, contact email/phone, address, free-form notes).
-- Many-to-many to Contact via BusinessAccountContact carrying an optional
-- role string.
--
-- Forward-only (CLAUDE.md §19). New enums, new tables, no destructive ops.

-- 1. Enums.
CREATE TYPE "BusinessAccountKind" AS ENUM ('school', 'partnership');

CREATE TYPE "BusinessAccountStatus" AS ENUM (
    'prospect',
    'active',
    'paused',
    'churned'
);

-- 2. BusinessAccount table.
CREATE TABLE "BusinessAccount" (
    "id"           TEXT NOT NULL,
    "kind"         "BusinessAccountKind" NOT NULL,
    "name"         TEXT NOT NULL,
    "slug"         TEXT NOT NULL,
    "color"        TEXT,
    "description"  TEXT,
    "status"       "BusinessAccountStatus" NOT NULL DEFAULT 'prospect',
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "website"      TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city"         TEXT,
    "postcode"     TEXT,
    "country"      TEXT,
    "notes"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "createdById"  TEXT,
    "updatedById"  TEXT,
    "archivedAt"   TIMESTAMP(3),
    CONSTRAINT "BusinessAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessAccount_kind_slug_key"
    ON "BusinessAccount"("kind", "slug");
CREATE INDEX "BusinessAccount_kind_idx" ON "BusinessAccount"("kind");
CREATE INDEX "BusinessAccount_status_idx" ON "BusinessAccount"("status");
CREATE INDEX "BusinessAccount_archivedAt_idx" ON "BusinessAccount"("archivedAt");

-- 3. BusinessAccountContact join table.
CREATE TABLE "BusinessAccountContact" (
    "accountId"   TEXT NOT NULL,
    "contactId"   TEXT NOT NULL,
    "role"        TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "BusinessAccountContact_pkey" PRIMARY KEY ("accountId", "contactId")
);

CREATE INDEX "BusinessAccountContact_contactId_idx"
    ON "BusinessAccountContact"("contactId");

ALTER TABLE "BusinessAccountContact"
    ADD CONSTRAINT "BusinessAccountContact_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "BusinessAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessAccountContact"
    ADD CONSTRAINT "BusinessAccountContact_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
