-- Internal team messaging (ADR 0022). Slack-style staff chat: public/private
-- channels, direct messages, threaded replies, @mentions, emoji reactions, and
-- inline references to CRM entities (Contact / Family / Card / Task).
-- Forward-only (CLAUDE.md §19). Message bodies are deliberately NOT mirrored
-- into the customer Interaction timeline or the compliance AuditLog; channel
-- administration is audited at the tRPC layer.

CREATE TYPE "ChatChannelKind" AS ENUM ('public', 'private', 'dm');
CREATE TYPE "ChatRefType" AS ENUM ('contact', 'family', 'card', 'task');

CREATE TABLE "ChatChannel" (
    "id"          TEXT NOT NULL,
    "name"        TEXT,
    "topic"       TEXT,
    "description" TEXT,
    "kind"        "ChatChannelKind" NOT NULL DEFAULT 'public',
    "isGeneral"   BOOLEAN NOT NULL DEFAULT false,
    "dmKey"       TEXT,
    "archivedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    CONSTRAINT "ChatChannel_pkey" PRIMARY KEY ("id")
);

-- Name uniqueness is enforced in the domain layer (a name can be reused after
-- the old channel is archived), so the name index is non-unique — mirroring
-- Board. The dmKey IS globally unique so "open DM with X" stays idempotent.
CREATE INDEX "ChatChannel_name_idx" ON "ChatChannel"("name");
CREATE UNIQUE INDEX "ChatChannel_dmKey_key" ON "ChatChannel"("dmKey");
CREATE INDEX "ChatChannel_kind_archivedAt_idx" ON "ChatChannel"("kind", "archivedAt");

CREATE TABLE "ChatChannelMember" (
    "id"          TEXT NOT NULL,
    "channelId"   TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "lastReadAt"  TIMESTAMP(3),
    "notifyLevel" TEXT NOT NULL DEFAULT 'all',
    "role"        TEXT NOT NULL DEFAULT 'member',
    "mutedAt"     TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatChannelMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatChannelMember_channelId_userId_key" ON "ChatChannelMember"("channelId", "userId");
CREATE INDEX "ChatChannelMember_userId_idx" ON "ChatChannelMember"("userId");

CREATE TABLE "ChatMessage" (
    "id"          TEXT NOT NULL,
    "channelId"   TEXT NOT NULL,
    "authorId"    TEXT NOT NULL,
    "body"        TEXT NOT NULL,
    "parentId"    TEXT,
    "replyCount"  INTEGER NOT NULL DEFAULT 0,
    "lastReplyAt" TIMESTAMP(3),
    "editedAt"    TIMESTAMP(3),
    "deletedAt"   TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatMessage_channelId_parentId_createdAt_idx" ON "ChatMessage"("channelId", "parentId", "createdAt");
CREATE INDEX "ChatMessage_parentId_createdAt_idx" ON "ChatMessage"("parentId", "createdAt");
CREATE INDEX "ChatMessage_channelId_createdAt_idx" ON "ChatMessage"("channelId", "createdAt");

CREATE TABLE "ChatMention" (
    "id"        TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "readAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatMention_messageId_userId_key" ON "ChatMention"("messageId", "userId");
CREATE INDEX "ChatMention_userId_readAt_idx" ON "ChatMention"("userId", "readAt");

CREATE TABLE "ChatMessageRef" (
    "id"        TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "refType"   "ChatRefType" NOT NULL,
    "refId"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessageRef_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatMessageRef_refType_refId_idx" ON "ChatMessageRef"("refType", "refId");
CREATE INDEX "ChatMessageRef_messageId_idx" ON "ChatMessageRef"("messageId");

CREATE TABLE "ChatReaction" (
    "id"        TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "emoji"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatReaction_messageId_userId_emoji_key" ON "ChatReaction"("messageId", "userId", "emoji");
CREATE INDEX "ChatReaction_messageId_idx" ON "ChatReaction"("messageId");

-- Foreign keys. Channel/message-scoped rows cascade with their parent. User,
-- contact and ref ids are stored as scalars without FK constraints (the
-- createdById convention, and refId is polymorphic across CRM entities).
ALTER TABLE "ChatChannelMember" ADD CONSTRAINT "ChatChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChatChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMention" ADD CONSTRAINT "ChatMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessageRef" ADD CONSTRAINT "ChatMessageRef_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatReaction" ADD CONSTRAINT "ChatReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the company-wide #general channel so every workspace has a landing spot.
-- Public channels are visible to all staff regardless of membership; membership
-- rows are created lazily when a user first opens the channel. Fixed id keeps
-- the seed idempotent across environments (singleton, like InvoicingSetting).
INSERT INTO "ChatChannel" ("id", "name", "topic", "kind", "isGeneral", "updatedAt")
VALUES ('seed-chat-general', 'general', 'Company-wide announcements and team chatter', 'public', true, CURRENT_TIMESTAMP);
