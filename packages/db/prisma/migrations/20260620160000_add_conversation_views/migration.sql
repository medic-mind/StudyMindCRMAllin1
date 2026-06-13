-- Trengo "Views" parity: per-user saved inbox filters, surfaced as custom
-- folders in the comms-centre rail.
CREATE TABLE "ConversationView" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" TEXT NOT NULL,
    "channel" TEXT,
    "tag" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationView_ownerUserId_sortOrder_idx" ON "ConversationView"("ownerUserId", "sortOrder");

ALTER TABLE "ConversationView"
    ADD CONSTRAINT "ConversationView_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
