<!-- StudyMind CRM PR template. CLAUDE.md §33. -->

## Summary

<!-- One paragraph: what changed, and why. -->

## Reviewer checklist (CLAUDE.md §33)

- [ ] **Correctness.** The change does what the description says.
- [ ] **Audit.** Any write that touches Contact, FinancialAccount, or
      safeguarding fields lands in `AuditLogEntry`.
- [ ] **Retention.** Soft-delete or retention policy honoured for any new
      data type. CLAUDE.md §21.
- [ ] **Accessibility.** Keyboard reachable; no `outline: none` without a
      replacement focus ring; axe-clean on touched UI. CLAUDE.md §28.
- [ ] **Test coverage.** Unit + integration where relevant; webhook
      handlers ship with a fixture; AI changes pass the eval harness.
- [ ] **Doc updates.** CLAUDE.md, runbooks, and ADRs updated in the same
      PR if the change contradicts existing docs.

## Money / safeguarding / external mutation

If this PR touches money, safeguarding, or any external mutation
(refunds, charges, message sends, role grants):

- [ ] Confirmed intent in plain English with the requester.
- [ ] Change is reversible (soft delete, draft, manual confirmation).
- [ ] Audit entry written.
- [ ] Failure-path test added, not just the happy path.

## Test plan

<!-- How a reviewer can verify this locally. -->
