-- Customisable Direct Debit recovery settings (ADR 0045 amendment). Singleton
-- so the late fee, cadence, response window, finance phone and letterhead are
-- editable from Settings rather than hardcoded/env-only. Forward-only; the row
-- is seeded with the current defaults (idempotent).

CREATE TABLE "DdRecoverySettings" (
  "id"                 TEXT NOT NULL,
  "lateFeeMinor"       INTEGER NOT NULL DEFAULT 1200,
  "defaultCadenceDays" INTEGER NOT NULL DEFAULT 7,
  "responseDays"       INTEGER NOT NULL DEFAULT 30,
  "financePhone"       TEXT NOT NULL DEFAULT '020 3305 9593',
  "companyName"        TEXT NOT NULL DEFAULT 'Medic Mind',
  "companyAddress"     TEXT NOT NULL DEFAULT '16 Tottenhall Rd, London N13 6HX',
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  "createdById"        TEXT,
  "updatedById"        TEXT,
  CONSTRAINT "DdRecoverySettings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "DdRecoverySettings" ("id", "updatedAt")
VALUES ('dd_recovery', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
