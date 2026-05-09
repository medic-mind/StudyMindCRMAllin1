-- Slice 14: super_admin role + user management + cron heartbeat.
-- CLAUDE.md §19 (enums append-only), §20 (RBAC), ADR 0009.

-- Enums are append-only in Postgres (CLAUDE.md §19).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'super_admin';

-- New enum for invite lifecycle.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserInviteStatus') THEN
    CREATE TYPE "UserInviteStatus" AS ENUM ('pending', 'accepted', 'cancelled', 'expired');
  END IF;
END$$;

-- User: clerkUserId becomes nullable (seeded super-admins exist pre-signup).
ALTER TABLE "User" ALTER COLUMN "clerkUserId" DROP NOT NULL;

-- User: deactivation columns.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deactivationReason" TEXT;

-- UserInvite: pending invites tracked here so the Clerk webhook can reconcile.
CREATE TABLE IF NOT EXISTS "UserInvite" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "lastName" TEXT,
  "rolesJson" JSONB NOT NULL,
  "clerkInvitationId" TEXT,
  "status" "UserInviteStatus" NOT NULL DEFAULT 'pending',
  "invitedById" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedUserId" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT,
  "updatedById" TEXT,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "UserInvite_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "UserInvite_email_idx" ON "UserInvite" ("email");
CREATE INDEX IF NOT EXISTS "UserInvite_status_idx" ON "UserInvite" ("status");

-- CronRun: heartbeat for the cron watchdog. CLAUDE.md §17, §25.
CREATE TABLE IF NOT EXISTS "CronRun" (
  "id" TEXT NOT NULL,
  "functionId" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3) NOT NULL,
  "errorCode" TEXT,
  CONSTRAINT "CronRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CronRun_functionId_finishedAt_idx"
  ON "CronRun" ("functionId", "finishedAt");
