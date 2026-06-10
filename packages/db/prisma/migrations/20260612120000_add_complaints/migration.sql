-- Complaints system (logged against a Contact; follow-ups/action points + optional Task link)

CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT,
    "assigneeId" TEXT,
    "taskId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComplaintUpdate" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActionPoint" BOOLEAN NOT NULL DEFAULT false,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ComplaintUpdate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Complaint_taskId_key" ON "Complaint"("taskId");
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");
CREATE INDEX "Complaint_contactId_createdAt_idx" ON "Complaint"("contactId", "createdAt");
CREATE INDEX "Complaint_assigneeId_idx" ON "Complaint"("assigneeId");
CREATE INDEX "ComplaintUpdate_complaintId_createdAt_idx" ON "ComplaintUpdate"("complaintId", "createdAt");

ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ComplaintUpdate" ADD CONSTRAINT "ComplaintUpdate_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
