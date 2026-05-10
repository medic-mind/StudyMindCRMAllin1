-- ADR 0012: per-agent Gmail OAuth flow. Adds status + cipher pointer to User.
--
-- gmailConnectionStatus is a free-form text column (no Postgres enum) so we
-- can extend later without a shadow-column migration. Allowed values today:
--   'connected' | 'needs_reconnect' | 'disconnected' | NULL.
--
-- gmailRefreshTokenCipherId points at the EncryptedField row holding the
-- KMS-encrypted refresh token. Not enforced as a foreign key — the
-- EncryptedField row is created/dropped in lock-step with the connection
-- in /api/oauth/gmail/{connect,callback} and the disconnect mutation.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gmailConnectionStatus" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gmailRefreshTokenCipherId" TEXT;
