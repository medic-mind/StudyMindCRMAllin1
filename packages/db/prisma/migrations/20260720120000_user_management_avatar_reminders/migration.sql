-- User-management upgrade (ADR 0021 amendment): preset profile pictures +
-- automated "finish signing in" reminder tracking. All nullable / defaulted,
-- forward-only.

ALTER TABLE "User"
  ADD COLUMN "avatarKey"           TEXT,
  ADD COLUMN "lastLoginReminderAt" TIMESTAMP(3),
  ADD COLUMN "loginReminderCount"  INTEGER NOT NULL DEFAULT 0;
