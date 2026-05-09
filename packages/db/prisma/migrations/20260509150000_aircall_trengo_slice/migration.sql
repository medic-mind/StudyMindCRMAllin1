-- Slice 5: Aircall + Trengo.
-- See CLAUDE.md §10 (Aircall), §11 (Trengo per-agent token), §19 (enum
-- additions are append-only), §21.1 (envelope encryption shape).

-- InteractionType: append-only additions for Trengo ticket lifecycle. The
-- call.* and message.* event names from §45 reuse the existing `call` and
-- `message` enum members; the registered event name lives in
-- Interaction.payload.interactionType (CLAUDE.md §45).
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'ticket_assigned';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'ticket_closed';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'ticket_reopened';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'label_added';
ALTER TYPE "InteractionType" ADD VALUE IF NOT EXISTS 'label_removed';

-- TrengoToken: per-agent KMS-encrypted Trengo API token. Expired tokens fail
-- closed in outbound (CLAUDE.md §11 — never fall back to a shared token).
CREATE TABLE "TrengoToken" (
    "agentId" TEXT NOT NULL,
    "tokenCiphertext" BYTEA NOT NULL,
    "tokenIv" BYTEA NOT NULL,
    "dekCiphertext" BYTEA NOT NULL,
    "aad" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TrengoToken_pkey" PRIMARY KEY ("agentId")
);

CREATE INDEX "TrengoToken_expiresAt_idx" ON "TrengoToken"("expiresAt");
