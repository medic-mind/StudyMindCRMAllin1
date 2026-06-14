-- Per-mailbox Gmail OAuth refresh token (ADR 0012 follow-up). Each connected
-- mailbox stores its own EncryptedField pointer so all connected accounts sync
-- independently, instead of sharing the single User.gmailRefreshTokenCipherId
-- that each new connect overwrote (only the default mailbox could sync).
ALTER TABLE "GmailMailbox" ADD COLUMN "refreshTokenCipherId" TEXT;
