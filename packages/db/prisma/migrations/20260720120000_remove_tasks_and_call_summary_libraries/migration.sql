-- Redesign 2026-07: remove the Tasks feature (full teardown across the CRM),
-- the Asana task-sync integration, and the call-summary Templates + Info-pack
-- document libraries. Add the webinar Zoom-rotation reminder recipient.
--
-- Forward-only (CLAUDE.md §19). Historical `call_summary` / `call_summary_sent`
-- Interaction enum values are retained (append-only enums); only the standalone
-- tables/enum below are dropped. IF EXISTS keeps the migration idempotent.

-- Complaint no longer links to a follow-up Task.
ALTER TABLE "Complaint" DROP CONSTRAINT IF EXISTS "Complaint_taskId_fkey";
DROP INDEX IF EXISTS "Complaint_taskId_key";
ALTER TABLE "Complaint" DROP COLUMN IF EXISTS "taskId";

-- The Tasks feature (Task model + TaskStatus enum).
DROP TABLE IF EXISTS "Task" CASCADE;
DROP TYPE IF EXISTS "TaskStatus";

-- Asana integration (task-only; no non-task surface remains).
DROP TABLE IF EXISTS "AsanaWebhook" CASCADE;

-- Call-summary Templates + Info-pack document libraries.
DROP TABLE IF EXISTS "CallSummaryTemplate" CASCADE;
DROP TABLE IF EXISTS "InfoPackDocument" CASCADE;

-- Webinar Zoom-rotation reminder recipient (task-free replacement for the old
-- rotation-reminder Task).
ALTER TABLE "WebinarSettings" ADD COLUMN IF NOT EXISTS "rotationReminderEmail" TEXT;
