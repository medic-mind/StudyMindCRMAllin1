# ADR 0015: Operator-managed dynamic sales pipeline

- Status: Accepted
- Date: 2026-05-24
- Affects: CLAUDE.md §6.4, §27, §37

## Context

The CRM was built around a hardcoded five-value `FamilyState` enum
(`lead | trial | active | at_risk | churned`). The kanban, the pipeline
transition mutation, the at-risk derivation, the churn-score job, and a
handful of UI affordances all read from it. The sales-CRM pivot
(ADR 0011, ADR 0013, ADR 0014) repositions the product as a sales tool;
the team now wants to own the funnel themselves — add a "Discovery"
column, split "Active" into "Active – paid" and "Active – PAYG", rename
"Churned" to "Lost (won't reconsider)", and so on. None of those changes
is possible without a code release while the enum is the source of truth.

## Decision

Introduce `PipelineStage`, an operator-managed table that owns the sales
pipeline. Each Family points at one stage via `Family.stageId` (nullable
FK with `onDelete: SetNull`). CEO and Senior Manager can create, rename,
recolour, reorder, archive (with mandatory family-reassignment when the
stage is occupied), and restore stages. Sales Executive and above can
move a family between stages — the move writes a `family_pipeline_moved`
Interaction and an audit row in one transaction.

The legacy `Family.state` enum is **kept** per CLAUDE.md §19 forward-only
rule. The `moveFamily` writer mirrors the new stage back into `state` on
a best-effort basis when the stage name maps to a known enum value
(`mirrorStateForStage`). Consumers that still read `state` —
`packages/core/finance/at-risk.ts`, the churn-score job, the
reconciliation engine — keep working; for custom-named stages the column
becomes stale and those derivations simply reflect the family's last
legacy state until the column is retired in a future PR.

The migration seeds the five legacy enum values as default stages so the
kanban looks unchanged on day one, and back-fills `Family.stageId` with a
case-insensitive name match against `INITCAP(REPLACE(state, '_', ' '))`.

## Alternatives considered

- **Multi-board pipelines.** Allow per-team boards (one for parents, one
  for LA contracts). Deferred: the team is one shared funnel today and
  the data model rework is large. Easy to extend later by adding a
  `PipelineBoard` parent and a `boardId` on `PipelineStage`.
- **Drag-and-drop reorder + move.** Rejected per CLAUDE.md §3 — humans
  confirm money/state changes. The kanban uses an explicit "Move to…"
  dropdown and the manage page uses ↑/↓ buttons. Drag UX can layer on
  later without a server change.
- **Drop the legacy enum in this PR.** Rejected — finance reconciliation,
  the at-risk derivation, and the churn-score job all read it, and a
  big-bang removal violates §19. A follow-up PR can shadow-column and
  retire it once consumers are migrated to `stageId`.

## Consequences

- The hardcoded `FamilyState` enum is now a compatibility surface, not
  the source of truth. Two-PR retirement is the path: (1) migrate the
  remaining readers to `stageId` lookups, (2) drop the column once no
  reader remains.
- `pipeline.stage.*` actions land on the permission matrix gate via
  in-router role checks (CEO + Senior Manager). A future ADR can promote
  these into named `Action`s in `packages/core/auth/policies.ts` if the
  matrix grows finer-grained.
- The `isClosed` flag on a stage replaces "churned as enum value". Any
  number of closed stages is allowed (e.g. "Lost", "Won (off-platform)",
  "Refunded out"). The kanban renders closed stages muted with a "Closed"
  pill.
- Pipeline UI hides the per-card move dropdown for Virtual Assistants;
  the server `pipeline.family.move` mutation also rejects them. UI and
  server gates match (CLAUDE.md §20).
- New events registered: `family.pipeline_moved`,
  `pipeline.stage.{created,updated,reordered,archived,restored}`. The
  `family_pipeline_moved` Interaction enum value is appended in the same
  migration as the schema change.
