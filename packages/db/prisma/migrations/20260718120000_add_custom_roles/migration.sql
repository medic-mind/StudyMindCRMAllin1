-- CustomRole: operator-managed additive permission bundles (§20, ADR 0021 follow-on).
CREATE TABLE "CustomRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "CustomRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomRole_name_key" ON "CustomRole"("name");
CREATE INDEX "CustomRole_archivedAt_idx" ON "CustomRole"("archivedAt");

-- UserCustomRole: assignment of a custom role to a user.
CREATE TABLE "UserCustomRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customRoleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "UserCustomRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserCustomRole_userId_customRoleId_key" ON "UserCustomRole"("userId", "customRoleId");
CREATE INDEX "UserCustomRole_customRoleId_idx" ON "UserCustomRole"("customRoleId");

ALTER TABLE "UserCustomRole" ADD CONSTRAINT "UserCustomRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCustomRole" ADD CONSTRAINT "UserCustomRole_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
