# ADR 0018: Multi-board cards

- Status: Accepted
- Date: 2026-05-25
- Affects: CLAUDE.md §6.4, §27, §37; supersedes the single-board assumption of ADR 0015

## Context

ADR 0015 shipped a single, operator-managed dynamic sales pipeline:
global `PipelineStage` rows, `Family.stageId`, a `pipeline.stages.*` +
`pipeline.family.move` tRPC surface, and the `/pipeline` kanban. One
funnel served the whole team.

Operators now want several independent pipelines. The B2C sales funnel,
a Summer Camp intake, and a B2B / Local-Authority pipeline each need
their own columns, their own cards, and their own quick actions — a
"Discovery → Active" set for sales looks nothing like an "Enquiry →
Booked → Delivered" set for the camp. With a single global stage list,
adding a camp column pollutes the sales board and vice versa. The team
also wants lightweight cards they can spin up from a phone call without
first creating a full billing Family, and a way to colour-code cards by
line of business.

## Decision

Introduce four models (`Board`, `Card`, `Label`, `Subject`) and add a
`boardId` to `PipelineStage`.

- **Board** owns a set of stages and cards. Exactly one board is the
  default (enforced in app logic via `ensureSingleDefault`, not a DB
  constraint, so swapping the default is atomic). Board management
  (create, rename, reorder, archive, configure quick actions) is CEO +
  Senior Manager only.
- **Card** is the new board representation of a prospect. It is backed by
  a **Contact** — lighter than a Family — lives in exactly one stage of
  one board, carries an optional **Subject**, and any number of
  **Labels**. Card CRUD and moves are Sales Executive and above;
  Virtual Assistants are read-only.
- **PipelineStage** gains a nullable `boardId` (cascade on board delete).
  The position-uniqueness index moves from global `(position)` to
  per-board `(boardId, position) WHERE archivedAt IS NULL`, so two boards
  can each have a position 1.
- **Per-board quick actions.** Each board configures a "tick" and an "x"
  target stage (`tickActionStageId`, `xActionStageId`) — e.g. mark a call
  answered → move to Active; no answer → move to Not answered. Slices 3+
  wire these to the card UI.

The data migration creates one default board ("Sales Pipeline"), adopts
every existing stage onto it, ensures "Call completed" and "Not answered"
stages exist, configures the default quick actions, and back-fills one
Card per existing Family that has a stage (using the family's billing
contact, else its first member; families with no contact are skipped).

`Family.stageId` is **retained** per CLAUDE.md §19 forward-only rule.
Reconciliation, the at-risk derivation, and the churn-score job keep
reading `state`/`stageId`. Family remains the billing unit; the Card is
purely the board-display representation.

## Alternatives considered

- **Cards as Families directly.** Rejected — a card needs to be cheaper
  than a billing unit. An agent logging an inbound call should not be
  forced to create a Family, a FinancialAccount, and member rows just to
  drop a card on a board. A Card references a single Contact and nothing
  more.
- **Tags vs labels.** Rejected free-text tags in favour of a `Label`
  table with a stored colour, so the board renders consistent coloured
  chips and operators manage the palette centrally.
- **A board-scoped stage list cloned per board vs shared stages.**
  Chose board-scoped: each board fully owns its columns. Sharing stages
  across boards would recreate the ADR-0015 coupling we are removing.

## Consequences

- `Family.stageId` is deprecated for board display in favour of
  `Card.stageId`; it stays as the finance/at-risk compatibility surface.
- The single-pipeline `/pipeline` route becomes a redirect to the default
  board view (`/boards/<defaultBoardId>`). The legacy `pipeline.*` router
  continues to function during the migration.
- New events registered: `board.created/updated/archived`,
  `card.created/moved/updated/archived`, `label.created`,
  `subject.created`. The `card_moved` Interaction enum value is appended
  in the same migration as the schema change.
- Drag-and-drop, the rich card modal, call-summary, and email surfaces
  are deferred to follow-up slices; this ADR covers the schema, domain,
  CRUD, and a basic board UI with an explicit "Move to…" dropdown.
