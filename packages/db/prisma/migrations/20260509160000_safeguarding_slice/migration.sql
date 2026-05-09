-- Slice 6: safeguarding workflow.
-- CLAUDE.md §42 — DSL rota and the LA contract retention override on
-- RetentionPolicy. SafeguardingFlag enum already has the three states we
-- need; no enum changes here.

-- DSL rota
CREATE TYPE "DslRotaRole" AS ENUM ('primary', 'deputy');

CREATE TABLE "DslRota" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "weekStart"   TIMESTAMP(3) NOT NULL,
    "weekEnd"     TIMESTAMP(3) NOT NULL,
    "role"        "DslRotaRole" NOT NULL,

    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "DslRota_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DslRota_weekStart_role_key" ON "DslRota"("weekStart", "role");
CREATE INDEX "DslRota_userId_idx" ON "DslRota"("userId");

-- RetentionPolicy.contractId already exists (initial migration); this slice
-- relies on the existing nullable FK — no DDL needed.
