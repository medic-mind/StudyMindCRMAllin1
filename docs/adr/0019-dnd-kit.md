# ADR 0019 — @dnd-kit for board drag-and-drop

- Status: Accepted
- Date: 2026-05-26
- Supersedes: none
- Related: ADR 0018 (multi-board cards)

## Context

The board kanban (ADR 0018) lets operators move a Card between stages and
reorder within a stage. Until now the only affordance was a per-card
"Move to…" dropdown plus the tick/cross quick actions. Operators work fast and
expect to drag cards. We need a drag-and-drop library that is accessible
(CLAUDE.md §28, WCAG 2.2 AA), works with our React 18 + Next.js 15 App Router
client-island pattern (§26), and does not become a maintenance liability.

## Decision

Add `@dnd-kit/core`, `@dnd-kit/sortable`, and `@dnd-kit/utilities` to
`apps/web`. The board kanban becomes a client island (`BoardDnd.tsx`) that wraps
the columns in a `DndContext` with one `SortableContext` per column. Cards drag
between and within columns; on drop we call the existing audited `card.move`
mutation with the target `stageId` and new position, applying an optimistic
update and reverting on error.

`@dnd-kit` is chosen because it is headless (we keep our own markup and tokens),
ships first-class keyboard sensors and ARIA live-region announcements out of the
box, and is actively maintained and React-18 compatible.

## Alternatives rejected

- **react-beautiful-dnd** — effectively unmaintained (Atlassian archived it) and
  has known React 18 StrictMode issues. Not a safe long-term bet.
- **Native HTML5 drag-and-drop** — no built-in keyboard or screen-reader story,
  inconsistent across browsers, and would force us to hand-roll accessibility we
  get for free from dnd-kit.

## Consequences

Drag is an enhancement, never the only path: the "Move to…" dropdown and the
tick/cross quick actions remain as keyboard-accessible fallbacks (§28). A small
drag-activation distance threshold keeps a click (which opens the card modal,
PR #55) distinct from a drag. The server is unchanged in contract — it still
audits every move and writes the `card_moved` Interaction.
