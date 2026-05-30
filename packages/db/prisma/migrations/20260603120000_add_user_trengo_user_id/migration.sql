-- ADR 0020 Phase 6 — map CRM users to their Trengo identity so the
-- `assignee_id` on `ticket.assigned` webhooks can resolve to a CRM `User`,
-- and the comms-centre assignee badge can render a name instead of a raw
-- numeric id. CLAUDE.md §11.
--
-- Forward-only (CLAUDE.md §19); additive (nullable column). Populated at
-- token-connect time from Trengo `/me`; backfilling existing tokens is a
-- no-op admin task (re-connect, which the 14-day rotation banner already
-- prompts on).

ALTER TABLE "User"
    ADD COLUMN "trengoUserId" INTEGER;

-- Partial unique index: PostgreSQL allows multiple NULLs in a UNIQUE
-- constraint by default, but Prisma's `@unique` on a nullable column
-- generates this index — keep it explicit so the migration file is
-- self-documenting.
CREATE UNIQUE INDEX "User_trengoUserId_key" ON "User"("trengoUserId");
