-- Direct Debit recovery-comms templates (ADR 0038, Phase 3). Staff-authored
-- reminder / legal-escalation messages used to draft a human-confirmed send
-- from a recovery case. We ship no copy — bodies start empty.
CREATE TYPE "DdRecoveryTemplateKind" AS ENUM ('reminder', 'legal_escalation', 'other');
CREATE TYPE "DdRecoveryChannel" AS ENUM ('email', 'trengo', 'sms');

CREATE TABLE "DdRecoveryTemplate" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "kind"        "DdRecoveryTemplateKind" NOT NULL DEFAULT 'reminder',
  "channel"     "DdRecoveryChannel" NOT NULL DEFAULT 'email',
  "subject"     TEXT,
  "body"        TEXT NOT NULL DEFAULT '',
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "archivedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdById" TEXT,
  "updatedById" TEXT,
  "deletedAt"   TIMESTAMP(3),
  CONSTRAINT "DdRecoveryTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DdRecoveryTemplate_kind_idx" ON "DdRecoveryTemplate"("kind");
CREATE INDEX "DdRecoveryTemplate_channel_idx" ON "DdRecoveryTemplate"("channel");
CREATE INDEX "DdRecoveryTemplate_archivedAt_idx" ON "DdRecoveryTemplate"("archivedAt");
