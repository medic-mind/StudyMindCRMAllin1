-- Display name of the most recent inbound message's sender (email From header
-- display name). The /mail list shows the actual sender like Gmail, instead of
-- falling back to a matched CRM contact's name for every conversation.
ALTER TABLE "Conversation" ADD COLUMN "lastSenderName" TEXT;
