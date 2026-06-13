-- GoCardless `count` for fixed-length plans (ADR 0038, CLAUDE.md §6.3). Lets
-- the Direct Debit shortfall engine know a plan's total contracted value
-- (count × amountMinor) so a plan cancelled/finished part-way surfaces the
-- amount still due. Nullable: open-ended plans have no count.
ALTER TABLE "GcSubscription" ADD COLUMN "totalPaymentCount" INTEGER;
