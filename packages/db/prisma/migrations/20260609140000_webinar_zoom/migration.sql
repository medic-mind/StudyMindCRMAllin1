-- Zoom integration (ADR 0035): app-generated meeting links + recording
-- distribution. Forward-only; additive columns + one new log table.

-- WebinarClass: link the generated Zoom meeting + its host.
ALTER TABLE "WebinarClass"
  ADD COLUMN "zoomMeetingId" TEXT,
  ADD COLUMN "zoomHostEmail" TEXT;

-- WebinarSettings: Zoom feature flags (all default OFF) + default host.
ALTER TABLE "WebinarSettings"
  ADD COLUMN "zoomAutoCreate"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "zoomSendRecordings" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "zoomTrashAfterSend" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "zoomHostEmail"      TEXT;

-- Per-occurrence recording dispatch log (idempotency for the recordings job).
CREATE TABLE "WebinarRecordingDispatch" (
    "id"             TEXT NOT NULL,
    "classId"        TEXT NOT NULL,
    "occurrenceUuid" TEXT NOT NULL,
    "shareUrl"       TEXT,
    "status"         TEXT NOT NULL DEFAULT 'sent',
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "error"          TEXT,
    "sentAt"         TIMESTAMP(3),
    "trashedAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebinarRecordingDispatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebinarRecordingDispatch_classId_occurrenceUuid_key" ON "WebinarRecordingDispatch"("classId", "occurrenceUuid");
CREATE INDEX "WebinarRecordingDispatch_status_idx" ON "WebinarRecordingDispatch"("status");
