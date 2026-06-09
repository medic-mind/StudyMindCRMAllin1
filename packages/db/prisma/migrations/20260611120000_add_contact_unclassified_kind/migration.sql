-- Add a neutral "unclassified" ContactKind. Auto-created contacts (unknown
-- callers, web leads, Trengo imports, Stripe payers) and the create forms now
-- default to this instead of assuming "parent"; a contact is only a
-- parent/student/tutor once a human classifies it. Postgres enums are
-- append-only (CLAUDE.md §19). The data reset of existing "parent" rows runs
-- in the NEXT migration so the new value is committed before it is used.
ALTER TYPE "ContactKind" ADD VALUE IF NOT EXISTS 'unclassified';
