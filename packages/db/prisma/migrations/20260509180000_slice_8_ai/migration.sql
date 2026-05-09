-- Slice 8: AI features — status summary, churn score, drift sampling.
-- CLAUDE.md §18, §18.3.

CREATE TABLE "ContactStatusSummary" (
    "contactId" TEXT NOT NULL,
    "headerLine" TEXT NOT NULL,
    "bodyLine" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactStatusSummary_pkey" PRIMARY KEY ("contactId")
);

CREATE INDEX "ContactStatusSummary_generatedAt_idx"
    ON "ContactStatusSummary"("generatedAt");

CREATE TABLE "ChurnScore" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "drivers" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChurnScore_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChurnScore_familyId_scoredAt_idx"
    ON "ChurnScore"("familyId", "scoredAt");

CREATE TABLE "DriftSample" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewerNote" TEXT,

    CONSTRAINT "DriftSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriftSample_task_sampledAt_idx" ON "DriftSample"("task", "sampledAt");
CREATE INDEX "DriftSample_reviewed_idx" ON "DriftSample"("reviewed");
