-- Let Notes / Activity / Tasks hang off a B2B account (School / Partnership)
-- the same way they do off a Contact, so the account view is as in-depth as
-- the customer view. Forward-only, additive (CLAUDE.md §19).

ALTER TABLE "Interaction" ADD COLUMN "businessAccountId" TEXT;
ALTER TABLE "Task" ADD COLUMN "businessAccountId" TEXT;

CREATE INDEX "Interaction_businessAccountId_occurredAt_idx"
  ON "Interaction"("businessAccountId", "occurredAt");
CREATE INDEX "Task_businessAccountId_idx" ON "Task"("businessAccountId");

ALTER TABLE "Interaction"
  ADD CONSTRAINT "Interaction_businessAccountId_fkey"
  FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_businessAccountId_fkey"
  FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
