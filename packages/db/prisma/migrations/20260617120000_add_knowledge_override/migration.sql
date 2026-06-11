-- Protocols & Policies knowledge base (ADR 0040): in-app edits. One row
-- (id = 'knowledge') holds the full live knowledge JSON once edited;
-- no row = the checked-in baseline is live. AI proposes patches, a human
-- (CEO / Senior Manager) confirms; every apply / reset is audited.
CREATE TABLE "KnowledgeOverride" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "KnowledgeOverride_pkey" PRIMARY KEY ("id")
);
