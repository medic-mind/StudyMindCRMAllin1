# CRM UI overhaul — audit & staged roadmap

Owner-facing plan for moving the CRM from "lots of inline panels" to focused
**workflow pop-ups**, consistent surfaces, and **operator-configurable** behaviour
(so managers change things in Settings, not in code). Staged so each step ships
as its own reviewable PR.

Guiding principles (the "think like a manager who won't recode later" rule):
1. **Workflow pop-ups over inline clutter** — one decision per modal/drawer, a
   clear primary action, guarded confirms for risky/irreversible steps.
2. **Configurable, not hardcoded** — channels, templates, quick actions, board
   columns, labels, stages are all data rows editable in Settings (continue the
   pattern already used for Slack channels, call-summary templates, board quick
   actions, labels).
3. **In-house, not bounced out** — call/email/log happen inside the CRM
   (Aircall/Google Voice dial, in-house compose) rather than handing off to the
   OS.
4. **One design system** — shared `Card` / `Field` / `Toolbar` / modal / drawer
   primitives; no bespoke one-off panels.

---

## Shipped (increment 1 — this PR)

- **In-house email everywhere.** A single global composer (`ComposeEmailProvider`
  in the app shell, `useComposeEmail()`), sent from the agent's connected Gmail
  via `mail.compose`. `EmailLink` now opens it (prefilled to the address) on
  board cards, Contacts, and Accounts — falling back to `mailto:` only when no
  composer is mounted. VAs can draft but not send (role-gated).
- **Board cards** already carry name + clickable phone (Aircall / Google Voice
  picker) + email preview; email now opens the in-house composer. (If a card
  shows only a name, that contact has no phone/email saved yet.)
- **Contacts quick-add pop-up** — essentials-only modal from the list header
  (role · name · email · phone), with "Full form →" to `/contacts/new`.

---

## Staged plan (next increments)

### Increment 2 — Shared workflow-popup foundation
- **`<Modal>` + `<SlideOver>` primitives** (focus-trap, Esc-to-close, restore
  focus, `prefers-reduced-motion`) — replace the hand-rolled fixed-overlay divs
  (compose, quick-add, card modal) with one accessible primitive (CLAUDE.md §28).
- **`useConfirm()` guarded-dialog hook** — replace `window.confirm` (bulk
  delete/merge, card delete) with a branded confirm dialog that states what
  happens and whether it's reversible.
- **⌘K command palette + quick-create** — global launcher: find a contact,
  new contact, log a call, compose email, new card, jump to a page.

### Increment 3 — Contacts (deep)
- Contact **detail page** → tabbed/slide-over sections; sticky identity header
  with one-click call/email/log; "Current status" summary band.
- Inline edit of core fields via a slide-over rather than a separate page.
- Per-row hover **quick actions** (call · email · add task) on the list.

### Increment 4 — Boards / pipeline
- Card modal → standardise on the `<Modal>`/`<SlideOver>` primitive; group the
  call-summary + quick-action + move controls into a single clear rail.
- **Configurable card face** — let managers choose which preview fields show on
  a card (phone, email, subject, labels, scheduled call, last activity) per
  board, persisted on the board (no recode).
- Column WIP limits + per-column colour already exist; expose them in board
  settings consistently.

### Increment 5 — Inbox / Comms Centre
- Reply composer → quick-reply picker + in-house compose parity; guarded send.
- Triage actions (assign/snooze/close) as a consistent action bar + confirms.

### Increment 6 — Finance / Reports / Dashboard
- Dashboard → configurable KPI tiles (operator picks which metrics show).
- Finance tables → consistent `Card`/`Toolbar`, empty/error states per §26.
- Reports → shared export button + filter bar.

### Increment 7 — Accounts & Tasks
- Accounts detail parity with Contacts (tabs/slide-over, in-house comms).
- Tasks → board/list toggle, quick-add modal, guarded bulk actions.

### Cross-cutting (every increment)
- Empty/error/loading states to the §26 standard (say what belongs here + the
  action that creates it; never "No data").
- Accessibility sweep per §28 (keyboard reachability, visible focus, axe in CI).
- Keep all new behaviour **configurable in Settings** where a manager would
  reasonably want to change it later.
