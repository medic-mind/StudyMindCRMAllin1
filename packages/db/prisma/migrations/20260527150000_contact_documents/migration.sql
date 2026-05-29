-- Per-contact document attachments stored in Postgres (no AWS dependency).
-- CLAUDE.md §4 (same trade-off the BrandingSetting uses for the logo).

CREATE TABLE "ContactDocument" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "ContactDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContactDocument_contactId_createdAt_idx"
    ON "ContactDocument"("contactId", "createdAt" DESC);

ALTER TABLE "ContactDocument"
    ADD CONSTRAINT "ContactDocument_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
