-- ADR 0021 Phase 5 — Gmail flag mirror for true two-way sync.
-- `mirrorThreadFlags` (inbound history sync) and the `mail.thread.*` outbound
-- actions both write these, so a star / archive / trash / read change made in
-- Gmail flows back into the CRM and vice-versa. Read state stays on
-- `unreadCount`; archived stays on `status='archived'`; these capture the rest.
ALTER TABLE "Conversation" ADD COLUMN "isStarred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "isTrashed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "flagsSyncedAt" TIMESTAMP(3);

CREATE INDEX "Conversation_provider_isStarred_idx" ON "Conversation"("provider", "isStarred");
CREATE INDEX "Conversation_provider_isTrashed_idx" ON "Conversation"("provider", "isTrashed");
