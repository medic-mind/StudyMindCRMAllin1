-- Conversation: full Gmail label-id mirror so /mail folders (Inbox/Primary/
-- Promotions/Spam/Important/Sent/…) are derived from Gmail's own labels and
-- mirror Gmail's views exactly (ADR 0021 Phase 5 — label-mirror). Forward-only.
ALTER TABLE "Conversation"
  ADD COLUMN "gmailLabelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- GIN index so `gmailLabelIds @> '{INBOX}'` / `&& '{CATEGORY_...}'` folder
-- queries stay fast on large mailboxes.
CREATE INDEX "Conversation_gmailLabelIds_idx"
  ON "Conversation" USING GIN ("gmailLabelIds");

-- Round-robin cursor for the gmail/sync resync-heal pass (oldest-checked first).
CREATE INDEX "Conversation_provider_flagsSyncedAt_idx"
  ON "Conversation" ("provider", "flagsSyncedAt");
