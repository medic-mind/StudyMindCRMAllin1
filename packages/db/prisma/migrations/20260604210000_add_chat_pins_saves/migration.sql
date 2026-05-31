-- Chat pins + saved items (ADR 0022 — pins & saves). Pins are shared, channel-
-- scoped; saved items are private per-user. Both cascade with their message.
-- Forward-only (CLAUDE.md §19).

CREATE TABLE "ChatPin" (
    "id"         TEXT NOT NULL,
    "messageId"  TEXT NOT NULL,
    "channelId"  TEXT NOT NULL,
    "pinnedById" TEXT NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatPin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatPin_messageId_key" ON "ChatPin"("messageId");
CREATE INDEX "ChatPin_channelId_createdAt_idx" ON "ChatPin"("channelId", "createdAt");

ALTER TABLE "ChatPin"
    ADD CONSTRAINT "ChatPin_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ChatSavedItem" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatSavedItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatSavedItem_userId_messageId_key" ON "ChatSavedItem"("userId", "messageId");
CREATE INDEX "ChatSavedItem_userId_createdAt_idx" ON "ChatSavedItem"("userId", "createdAt");

ALTER TABLE "ChatSavedItem"
    ADD CONSTRAINT "ChatSavedItem_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
