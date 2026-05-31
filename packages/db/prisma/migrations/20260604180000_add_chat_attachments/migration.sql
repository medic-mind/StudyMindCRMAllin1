-- Chat message attachments (ADR 0022 — richer messages). Bytes live in S3 with
-- SSE:KMS; this table holds metadata + the S3 key. Cascades with its message.
-- Forward-only (CLAUDE.md §19).

CREATE TABLE "ChatAttachment" (
    "id"          TEXT NOT NULL,
    "messageId"   TEXT NOT NULL,
    "filename"    TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes"   INTEGER NOT NULL,
    "s3Key"       TEXT NOT NULL,
    "width"       INTEGER,
    "height"      INTEGER,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatAttachment_messageId_idx" ON "ChatAttachment"("messageId");

ALTER TABLE "ChatAttachment"
    ADD CONSTRAINT "ChatAttachment_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
