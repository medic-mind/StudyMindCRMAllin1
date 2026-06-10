-- Info pack / brochure document library (Settings → Documents). PDFs the team
-- attaches to call-summary emails. Bytes inline (same approach as
-- CallSummaryTemplate.pdfData / ContactDocument.data) so self-hosted deploys
-- stay S3-free.
CREATE TABLE "InfoPackDocument" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "InfoPackDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InfoPackDocument_name_key" ON "InfoPackDocument"("name");
CREATE INDEX "InfoPackDocument_archivedAt_idx" ON "InfoPackDocument"("archivedAt");
CREATE INDEX "InfoPackDocument_sortOrder_idx" ON "InfoPackDocument"("sortOrder");
