-- ADR 0021 — Communications Hub, Phase 1: multi-account foundation.
--
-- `MailAccount` is the provider-agnostic unit of "a connected inbox",
-- generalising the Gmail-only `GmailMailbox`. One row per connected email
-- address — personal (one agent) or shared (a team inbox: info@, admissions@) —
-- across Gmail/Workspace/Outlook/Exchange/IMAP. Secrets are NEVER stored here
-- (OAuth refresh tokens / IMAP passwords live in `EncryptedField`, §21).
--
-- `MailAccountMember` mirrors `TeamMember` and grants staff access to a shared
-- inbox; personal accounts need no member rows (the owner is implicit).
--
-- Forward-only (CLAUDE.md §19). Additive only — all new tables/columns; nothing
-- existing is altered. For provider=gmail a row bridges to the legacy
-- `GmailMailbox` via `gmailMailboxId`, so the live Gmail sync is reused without
-- a destructive migration (§19.1). A later PR backfills `MailAccount` from
-- `GmailMailbox` and points the sync at it.

-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('gmail', 'google_workspace', 'outlook', 'exchange', 'imap');

-- CreateEnum
CREATE TYPE "MailAccountOwnerKind" AS ENUM ('personal', 'shared');

-- CreateEnum
CREATE TYPE "MailAccountStatus" AS ENUM ('connected', 'needs_reconnect', 'disconnected', 'error');

-- CreateTable
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "ownerKind" "MailAccountOwnerKind" NOT NULL DEFAULT 'personal',
    "ownerUserId" TEXT,
    "teamId" TEXT,
    "status" "MailAccountStatus" NOT NULL DEFAULT 'connected',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "syncCursor" TEXT,
    "watchExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "gmailMailboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailAccountMember" (
    "id" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'agent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "MailAccountMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_address_key" ON "MailAccount"("address");

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_gmailMailboxId_key" ON "MailAccount"("gmailMailboxId");

-- CreateIndex
CREATE INDEX "MailAccount_ownerUserId_deletedAt_idx" ON "MailAccount"("ownerUserId", "deletedAt");

-- CreateIndex
CREATE INDEX "MailAccount_ownerKind_status_idx" ON "MailAccount"("ownerKind", "status");

-- CreateIndex
CREATE INDEX "MailAccount_teamId_idx" ON "MailAccount"("teamId");

-- CreateIndex
CREATE INDEX "MailAccount_provider_idx" ON "MailAccount"("provider");

-- CreateIndex
CREATE INDEX "MailAccountMember_userId_idx" ON "MailAccountMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MailAccountMember_mailAccountId_userId_key" ON "MailAccountMember"("mailAccountId", "userId");

-- AddForeignKey
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_gmailMailboxId_fkey" FOREIGN KEY ("gmailMailboxId") REFERENCES "GmailMailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAccountMember" ADD CONSTRAINT "MailAccountMember_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
