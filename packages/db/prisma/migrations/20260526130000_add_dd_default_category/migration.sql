-- Slice B: Direct Debit defaulters. Forward-only enum add (CLAUDE.md §19).
-- The nightly finance/flag-dd-defaulters job raises a ReconciliationDiscrepancy
-- with this category for any newly-defaulted family.
ALTER TYPE "ReconciliationCategory" ADD VALUE IF NOT EXISTS 'direct_debit_default';
