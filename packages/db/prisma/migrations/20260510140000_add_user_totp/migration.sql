-- Audit-A2: TOTP MFA columns on User + TotpRecoveryCode table.
-- CLAUDE.md §20 (MFA mandatory for super_admin/admin/finance/dsl).
-- ADR 0010.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpSecretCipherId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totpEnabledAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "TotpRecoveryCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TotpRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TotpRecoveryCode_userId_usedAt_idx"
  ON "TotpRecoveryCode" ("userId", "usedAt");

ALTER TABLE "TotpRecoveryCode"
  ADD CONSTRAINT "TotpRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
