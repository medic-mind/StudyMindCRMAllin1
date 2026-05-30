-- BusinessAccount ↔ Company many-to-many. Mirrors ContactCompany so a
-- school / partnership can carry the same sister-brand tags Contacts
-- already have. Forward-only.

CREATE TABLE "BusinessAccountCompany" (
    "accountId"   TEXT NOT NULL,
    "companyId"   TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "BusinessAccountCompany_pkey" PRIMARY KEY ("accountId", "companyId")
);

CREATE INDEX "BusinessAccountCompany_companyId_idx"
    ON "BusinessAccountCompany"("companyId");

ALTER TABLE "BusinessAccountCompany"
    ADD CONSTRAINT "BusinessAccountCompany_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "BusinessAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessAccountCompany"
    ADD CONSTRAINT "BusinessAccountCompany_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
