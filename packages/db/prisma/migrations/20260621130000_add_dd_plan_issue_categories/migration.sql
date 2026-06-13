-- ADR 0038 (sixth amendment): proactive nightly flagging of plan-level Direct
-- Debit issues. Forward-only enum adds (CLAUDE.md §19). The nightly
-- finance/flag-dd-defaulters job raises a ReconciliationDiscrepancy with these
-- categories for fixed-length plans cancelled/finished early with money still
-- due, and active plans that have fallen behind their collection schedule.
ALTER TYPE "ReconciliationCategory" ADD VALUE IF NOT EXISTS 'direct_debit_plan_shortfall';
ALTER TYPE "ReconciliationCategory" ADD VALUE IF NOT EXISTS 'direct_debit_plan_arrears';
