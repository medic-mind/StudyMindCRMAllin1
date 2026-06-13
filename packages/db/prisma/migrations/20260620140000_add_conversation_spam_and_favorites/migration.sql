-- Trengo-parity inbox: Spam box + per-user Favorites.
-- Postgres enums are append-only (CLAUDE.md §19); 'spam' is not used in this
-- migration's DDL, so adding it here is safe.
ALTER TYPE "ConversationStatus" ADD VALUE IF NOT EXISTS 'spam';

-- Per-user "Favorite" star on a conversation (Personal → Favorites folder).
CREATE TABLE "ConversationFavorite" (
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationFavorite_pkey" PRIMARY KEY ("userId", "conversationId")
);

CREATE INDEX "ConversationFavorite_conversationId_idx" ON "ConversationFavorite"("conversationId");

ALTER TABLE "ConversationFavorite"
    ADD CONSTRAINT "ConversationFavorite_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationFavorite"
    ADD CONSTRAINT "ConversationFavorite_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
