-- Grantable per-user permissions (ADR 0021, CLAUDE.md §20). Sits on top of the
-- role matrix; today the only value is 'user.manage'. Forward-only (§19).

CREATE TABLE "UserPermission" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "permission"  TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "UserPermission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPermission_userId_permission_key" ON "UserPermission"("userId", "permission");

CREATE INDEX "UserPermission_userId_idx" ON "UserPermission"("userId");

ALTER TABLE "UserPermission"
    ADD CONSTRAINT "UserPermission_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
