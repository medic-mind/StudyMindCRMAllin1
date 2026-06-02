-- Extend the shared label catalogue (AccountLabel) to B2C customers via a
-- Contact ↔ AccountLabel junction — the customer counterpart of
-- BusinessAccountLabel. One catalogue, surfaced in the UI as "Labels".
--
-- Forward-only (CLAUDE.md §19); one new table, no impact on existing rows.

CREATE TABLE "ContactLabel" (
    "contactId"   TEXT NOT NULL,
    "labelId"     TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "ContactLabel_pkey" PRIMARY KEY ("contactId", "labelId")
);

CREATE INDEX "ContactLabel_labelId_idx" ON "ContactLabel"("labelId");

ALTER TABLE "ContactLabel"
    ADD CONSTRAINT "ContactLabel_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactLabel"
    ADD CONSTRAINT "ContactLabel_labelId_fkey"
    FOREIGN KEY ("labelId") REFERENCES "AccountLabel"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
