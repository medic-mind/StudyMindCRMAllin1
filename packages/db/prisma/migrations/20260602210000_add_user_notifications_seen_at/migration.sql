-- ADR 0020 Phase 5 — persist when each staff user last opened the
-- notifications bell. Lets notifications.list compute "unread" against a
-- real timestamp instead of the actor-vs-target heuristic Phase 1 used.
--
-- Forward-only (CLAUDE.md §19); additive (column is nullable, no default
-- needed). Null means "never opened" — every audit row aimed at the user is
-- unread until the first markSeen call.

ALTER TABLE "User"
    ADD COLUMN "notificationsSeenAt" TIMESTAMP(3);
