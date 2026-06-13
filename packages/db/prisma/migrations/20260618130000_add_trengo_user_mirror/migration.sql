-- Trengo team mirror (agents) so the CRM reflects the Trengo workspace's
-- users even when they never log into the CRM — drives the assignee picker,
-- assignee/sender name resolution, and email auto-linking to a CRM User.
CREATE TABLE "TrengoUser" (
  "id"            TEXT NOT NULL,
  "trengoUserId"  INTEGER NOT NULL,
  "name"          TEXT,
  "email"         TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "crmUserId"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrengoUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TrengoUser_trengoUserId_key" ON "TrengoUser"("trengoUserId");
CREATE INDEX "TrengoUser_email_idx" ON "TrengoUser"("email");
CREATE INDEX "TrengoUser_crmUserId_idx" ON "TrengoUser"("crmUserId");
