-- Contact extension fields, ContactLink, Team + TeamMember, Task.teamId.
-- All additive; CLAUDE.md §19 (forward-only).

-- 1. New enums.
CREATE TYPE "ContactSendStatus" AS ENUM (
    'none',
    'send_support',
    'ehcp_in_place',
    'ehcp_in_progress',
    'other'
);

CREATE TYPE "ContactLinkRelation" AS ENUM (
    'parent_of',
    'child_of',
    'guardian_of',
    'sibling_of',
    'spouse_of',
    'partner_of',
    'caseworker_for',
    'tutor_of',
    'student_of',
    'other'
);

-- 2. Contact extension columns. All nullable so existing rows stay valid.
ALTER TABLE "Contact"
    ADD COLUMN "addressLine1" TEXT,
    ADD COLUMN "addressLine2" TEXT,
    ADD COLUMN "city" TEXT,
    ADD COLUMN "postcode" TEXT,
    ADD COLUMN "country" TEXT,
    ADD COLUMN "schoolName" TEXT,
    ADD COLUMN "yearGroup" TEXT,
    ADD COLUMN "sendStatus" "ContactSendStatus",
    ADD COLUMN "jobTitle" TEXT,
    ADD COLUMN "pronouns" TEXT,
    ADD COLUMN "mailchimpEmail" TEXT;

-- 3. ContactLink table.
CREATE TABLE "ContactLink" (
    "id" TEXT NOT NULL,
    "fromContactId" TEXT NOT NULL,
    "toContactId" TEXT NOT NULL,
    "relation" "ContactLinkRelation" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "ContactLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactLink_fromContactId_toContactId_relation_key"
    ON "ContactLink"("fromContactId", "toContactId", "relation");

CREATE INDEX "ContactLink_toContactId_idx" ON "ContactLink"("toContactId");

ALTER TABLE "ContactLink"
    ADD CONSTRAINT "ContactLink_fromContactId_fkey"
    FOREIGN KEY ("fromContactId") REFERENCES "Contact"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ContactLink"
    ADD CONSTRAINT "ContactLink_toContactId_fkey"
    FOREIGN KEY ("toContactId") REFERENCES "Contact"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Team + TeamMember tables.
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "archivedAt" TIMESTAMP(3),
    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");
CREATE INDEX "Team_archivedAt_idx" ON "Team"("archivedAt");

CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

ALTER TABLE "TeamMember"
    ADD CONSTRAINT "TeamMember_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Task.teamId.
ALTER TABLE "Task" ADD COLUMN "teamId" TEXT;
CREATE INDEX "Task_teamId_status_idx" ON "Task"("teamId", "status");
ALTER TABLE "Task"
    ADD CONSTRAINT "Task_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
