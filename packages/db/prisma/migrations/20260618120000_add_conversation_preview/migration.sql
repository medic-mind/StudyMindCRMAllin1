-- Comms-centre list previews (Trengo parity): first ~140 chars of the
-- newest message, maintained by the conversation-head merger.
ALTER TABLE "Conversation" ADD COLUMN "lastMessagePreview" TEXT;
