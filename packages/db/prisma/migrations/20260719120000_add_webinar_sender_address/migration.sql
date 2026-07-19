-- WebinarSettings: the connected Gmail mailbox ADDRESS to send the weekly
-- reminder + class emails AS (e.g. info@studymind.co.uk). Selects that
-- mailbox's own OAuth token at send time. Null = the system default mailbox
-- (SYSTEM_GMAIL_EMAIL). Nullable, forward-only (CLAUDE.md §19).
ALTER TABLE "WebinarSettings" ADD COLUMN "senderAddress" TEXT;
