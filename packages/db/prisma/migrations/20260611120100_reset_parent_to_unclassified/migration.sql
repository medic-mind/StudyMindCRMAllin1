-- Operator decision: every contact currently typed "parent" was set by the
-- old auto-default (calls / web leads / Trengo / Stripe payers) or a pre-filled
-- form, not necessarily a deliberate classification. Reset them all to
-- "unclassified" so the type reflects a real human decision; staff reclassify
-- as needed (the type is now editable). Forward-only (CLAUDE.md §19). Runs in
-- its own transaction, after the enum value from the previous migration is
-- committed.
UPDATE "Contact" SET "kind" = 'unclassified' WHERE "kind" = 'parent';
