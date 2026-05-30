# ADR 0020 — CRM as the operational layer on top of Trengo

- Status: Accepted — Phases 1, 1+, 1++, 2, 2b, 2c, 3, 4, 5, 6a, 6b, 7a, 7b implemented. Remaining 6c / 6d tracked in `docs/audit/trengo-operational-layer-audit.md`.
- Date: 2026-05-30 (updated 2026-06-03)
- Supersedes: none
- Related: ADR 0017 (comprehensive customer view + backfill), CLAUDE.md §11

## Context

Staff today work across Trengo and several other tools. Many will keep using
Trengo as their primary inbox. We want the CRM to become the single pane of
glass for visibility, management and reporting **without** forcing anyone out
of Trengo, and with **automatic two-way synchronisation** so no work is done
twice.

The existing Trengo integration (audited in
`docs/audit/trengo-operational-layer-audit.md`) is solid on the inbound side
(verified webhook → idempotent `ProviderEvent` → Inngest job → `Interaction`,
per-agent KMS tokens, 90-day backfill, per-contact conversation grouping) but
thin on the outbound side, has no first-class conversation entity, and has no
real-time browser transport.

Two hard constraints from CLAUDE.md frame every choice here: **never silently
mutate data** (§3 — AI/automation suggests, humans confirm; no auto-merge) and
**do not duplicate systems or data** (§35).

## Decision

Build the operational layer as **additive layers on the existing integration**,
in the order below. Each phase is independently shippable and leaves
Trengo-first staff fully functional.

1. **Outbound foundation (this ADR, implemented).** A `interaction.trengo.reply`
   tRPC procedure reuses the existing audited `sendMessage`. A shared
   `resolveActiveTrengoConversation` resolver (in the Trengo package) is the one
   definition of "the contact's active ticket + channel", used by both the
   reply path and the card call-summary fan-out. The AI draft panel gains a real
   Send button for Trengo channels. Outbound loop-prevention reuses the existing
   `custom_fields.interactionId` echo-skip in the webhook job.

2. **Conversation head.** Add a lightweight `Conversation` model that holds a
   conversation's _current_ state (status, assignee, unread, lastMessageAt,
   channel, tag set) as **indexed columns**, keyed on the Trengo ticket id. It
   **references** the message bodies already stored in `Interaction` — it does
   not copy them. The webhook job upserts the head on every event; the inbox
   reads the head with a single indexed query.

3. **Real-time transport.** A server-sent-events endpoint pushes
   conversation/notification deltas to connected browsers, replacing polling.
   Redis pub/sub fans out across instances when we scale past one.

4. **Communication Centre.** `/inbox` becomes a two-pane conversation list +
   thread view (filters: assigned / unassigned / open / closed / unread /
   channel; saved views in the URL). It reuses `contact-channels` message shapes
   and the Phase-1 reply path.

5. **Full sync.** Assign / close / reopen / tag from the CRM call the existing
   (currently dead) `assignTicket` / `closeTicket` client methods and new tag
   calls, each echo-protected and audited. Inbound `contact.updated` / tag
   events update the conversation head and **suggest** contact-field changes for
   human confirmation (never silent-merge, §3). Add `User.trengoUserId` so a
   webhook `assignee_id` resolves to a CRM user.

6. **Resilience & scale.** An outbound retry queue drains `pending_send` on
   Trengo recovery; the rate limiter and a response cache move to Redis.

## Alternatives rejected

- **A parallel Trengo message/conversation store that copies message bodies.**
  Rejected: duplicates data we already hold in `Interaction` (§35) and creates a
  second source of truth to reconcile. The conversation _head_ references
  Interactions instead.
- **A generic webhook gateway / new "comms" service.** Rejected for the same
  reason CLAUDE.md §7.2 rejected it: provider quirks bleed through the
  abstraction, and we already have a working per-provider folder.
- **WebSockets for real-time.** Deferred in favour of SSE: our updates are
  server→client only, SSE is simpler on Railway + Next.js, and it needs no new
  dependency. WebSockets remain an option if we add client→server streaming.
- **Forcing staff into the CRM inbox.** Explicitly rejected by the brief.
  Success is measured by accurate automatic reflection of Trengo activity, not
  by inbox adoption.

## Consequences

- The first increment ships value immediately (reply from the CRM) with no
  schema change and no irreversible action.
- Later phases require additive, forward-only migrations (two-PR schema→backfill
  per §19.1) and a feature flag (`comm_centre_enabled`) for safe rollout.
- The Trengo Integration Layer remains the only code that talks to Trengo;
  no scattered `fetch` calls.
- The "no silent mutation" rule means inbound contact-field changes from Trengo
  are surfaced for confirmation, not auto-applied — a deliberate UX cost we
  accept for safety and GDPR.
