-- Additional points of contact per Contact (multiple emails / phone numbers /
-- other handles). The primary Contact.email + Contact.phoneE164 stay the
-- matching source of truth (lead dedup, call matching); these are
-- supplementary. Forward-only, defensively idempotent (CLAUDE.md §19).

-- Enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContactChannelKind') THEN
    CREATE TYPE "ContactChannelKind" AS ENUM ('email', 'phone', 'other');
  END IF;
END
$$;

-- Table
CREATE TABLE IF NOT EXISTS "ContactChannel" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "kind" "ContactChannelKind" NOT NULL,
  "value" TEXT NOT NULL,
  "label" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdById" TEXT,
  "updatedById" TEXT,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ContactChannel_pkey" PRIMARY KEY ("id")
);

-- FK (guarded so a re-run is a no-op)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ContactChannel_contactId_fkey'
  ) THEN
    ALTER TABLE "ContactChannel"
      ADD CONSTRAINT "ContactChannel_contactId_fkey"
      FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Indexes
CREATE INDEX IF NOT EXISTS "ContactChannel_contactId_idx" ON "ContactChannel" ("contactId");
CREATE INDEX IF NOT EXISTS "ContactChannel_kind_value_idx" ON "ContactChannel" ("kind", "value");
