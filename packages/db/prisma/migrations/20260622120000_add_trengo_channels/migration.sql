-- Named Trengo channels ("business numbers" / inboxes) — Trengo parity.
-- A conversation now records WHICH specific channel it is on (e.g. "Support
-- Manager" vs "Tutor Manager"), and we mirror the channel catalogue so the
-- inbox can list them by name with counts and filter by them.

ALTER TABLE "Conversation" ADD COLUMN "trengoChannelId" INTEGER;
ALTER TABLE "Conversation" ADD COLUMN "trengoChannelName" TEXT;

CREATE INDEX "Conversation_trengoChannelId_status_idx" ON "Conversation"("trengoChannelId", "status");

CREATE TABLE "TrengoChannel" (
    "id" TEXT NOT NULL,
    "trengoId" INTEGER NOT NULL,
    "name" TEXT,
    "trengoType" TEXT,
    "channelType" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrengoChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrengoChannel_trengoId_key" ON "TrengoChannel"("trengoId");
CREATE INDEX "TrengoChannel_channelType_idx" ON "TrengoChannel"("channelType");
