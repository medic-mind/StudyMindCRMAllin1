# ADR 0016: Drop the LA tender + AP placement schema

- Status: Accepted
- Date: 2026-05-24
- Decision drivers: ADR 0011, ADR 0013, ADR 0014, CLAUDE.md §19

## Context

The LA tender and Alternative Provision (AP) placement workflow was
discontinued in ADR 0011 ("Discontinue LA tender workflow"). That ADR
removed the application code that read or wrote those tables but left the
Prisma models in place as orphans, with a `DEPRECATED` note in CLAUDE.md
§43 ("retained as historical reference… do not add new code that
references them").

The subsequent safeguarding removal (ADR 0013) and sales-CRM pivot
(ADR 0014, ADR 0015) sharpened the product surface still further. The
orphan tables are now actively misleading:

- They appear in `prisma db pull` output and Prisma Studio with no UI or
  job behind them.
- New engineers reading `schema.prisma` see `Tender`, `LAContract`,
  `LAInvoice`, `LAProgressReport`, `TenderDraftRequest`, `APPlacement`
  and reasonably ask why the CRM "supports LA tenders". It does not.
- `Family.laContractId`, `Family.apPlacement`, `Interaction.tenderId`,
  and `Interaction.laContractId` carry FKs and indexes that the schema
  has to maintain for no benefit.
- The `ReconciliationCategory.ap_review_overdue` enum value is also
  dead.

## Decision

Drop the six orphan tables (`Tender`, `TenderDraftRequest`,
`LAContract`, `LAInvoice`, `LAProgressReport`, `APPlacement`), the
related columns on `Family` (`laContractId`, `apPlacement`) and
`Interaction` (`tenderId`, `laContractId`), the `TenderState` enum, and
the `ReconciliationCategory.ap_review_overdue` value in a single
forward-only migration (`drop_la_tender_tables`).

CLAUDE.md §19 forward-only allows table drops when no consumers exist.
A full repo grep at PR time confirmed zero references to `db.tender`,
`db.lAContract`, `db.lAInvoice`, `db.lAProgressReport`,
`db.tenderDraftRequest`, `db.aPPlacement`, or to the dropped column
names. The `ap_review_overdue` value had two stale references in
`apps/web/app/(app)/finance/page.tsx` and the finance router input
enum, both removed in the same commit.

The `InteractionType` enum still carries `tender_state_changed`,
`tender_draft_signed_off`, `lacontract_created`,
`lacontract_invoice_generated`, `lacontract_invoice_sent`,
`lacontract_invoice_paid`, `lacontract_progress_report_signed`, and
`ap_review_overdue` values. We leave those in place as harmless
dangling enum members; removing Postgres enum values requires the
two-PR shadow-column dance described in CLAUDE.md §19, and the cost is
not justified for values that no code path emits.

## Consequences

- Production safety: the table drops use `DROP TABLE IF EXISTS` and
  the migration is bracketed in `BEGIN; … COMMIT;` so a partial
  failure rolls back. There are no rows in any production environment
  (verified before merge).
- Restoration path: if the LA tender workflow is ever revived, the
  schema must be rebuilt from scratch (a new migration plus fresh
  model definitions). This ADR explicitly accepts that one-way door,
  on the basis that the previous shape was speculative and would need
  redesign anyway.
- Backups: PITR + nightly logical dumps retain the dropped tables for
  the retention window documented in CLAUDE.md §46.2, so a restore is
  possible inside that window for forensic or compliance needs.
