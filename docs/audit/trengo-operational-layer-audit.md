# Audit — CRM as the operational layer on top of Trengo

> Status: living document. Authored 2026-05-30. Owner: see `OWNERS.md`.
> Companion ADR: `docs/adr/0020-trengo-operational-layer.md`.
>
> **Implementation status (as of 2026-06-03)** — every phase below has a
> verified `main` landing referenced in the table:
>
> | Phase | What it ships | PR | Main commit |
> |---|---|---|---|
> | 1 | `interaction.trengo.reply`; shared resolver; draft panel sends; full audit + ADR 0020 | #93 | `f86fe77` |
> | 1+ | Close / reopen from CRM; webhook echo-skip via `linkCrmOutboundEcho`; per-card actions | #93 | `bd8198a` |
> | 1++ | Inbox honors snooze + assign; Active / Mine / Unassigned / Snoozed chips | #93 | `2254e9c` |
> | 2 | `Conversation` head model + migration; pure `applyEventToConversation` merger; webhook + outbound both write | #93 | `b6ddbfc` |
> | 2b | Comms Centre seed `/inbox/conversations` reading the head | #93 | `acdce79` |
> | 2c | One-shot Inngest backfill from existing Interactions; admin trigger | #94 | `8a2ff75` |
> | 3 | SSE endpoint + in-process bus + client hook; live list updates | #94 | `5c2edec` |
> | 4 | Comms Centre **thread view** at `/inbox/conversations/[id]` with inline reply / close / reopen | #96 | `3649822` |
> | 5 | `User.notificationsSeenAt` + `notifications.markSeen`; bell fires on open | #96 | `4b9ed88` |
> | 6a | `User.trengoUserId` mapping; assignee name surfaces in the list | #97 | `7173702` |
> | 7a | Outbound retry queue (`trengo/retry-pending-send`, 5-min cron, capped attempts, TOKEN_EXPIRED skip) | #97 | `3bb028e` |
>
> **Open follow-ups**: none — every phase from the original roadmap is on `main`.
>
> **Newly landed (post-PR #98):**
> - **6b** — contact-level tag aggregation derived from the Conversation head; chip row on the contact detail page.
> - **6c** — contact-field suggestions from inbound `contact.updated`; `ContactFieldSuggestion` table; review queue at `/inbox/suggestions` (Manager+ accepts/rejects, never silent-merge per §3).
> - **6d** — Trengo message attachments persisted to S3 (SSE:KMS), surfaced as inline chips with download links in the comms-centre thread view.
> - **6e** — assign a conversation to a teammate from the CRM (drives Trengo `assignTicket` via `User.trengoUserId`; echo-skipped + retry-covered).
> - **7b** — Redis pub/sub fan-out for multi-instance SSE (lazy-init, falls back to in-process when `REDIS_URL` is unset).
> - **Browser notifications** (original brief Phase 6) — opt-in desktop notifications via the Web Notifications API; client-only (`apps/web/lib/hooks/use-browser-notifications.ts`), high-water dedupe, fires only on server-flagged unread rows. Toggle in the bell dropdown.
> - **Inbox UI Trengo-parity pass** — researched against Trengo's own help-centre UX and closed the visible gaps: a prominent **Close (✓) / Reopen** action now sits in the thread header (where Trengo puts it) instead of only at the bottom of the composer; the composer gained Trengo's combined **"Send & close"** (`mutateAsync` chains the close only after the reply actually sends); the internal-notes tab is labelled **"Comment"** (Trengo's term). Layout/terminology already matched (3-pane cockpit, folders New/Assigned/All open/Snoozed/Closed + Assigned to me, "Closed" not "Resolved", "Labels" not "Tags", Reply/Comment tabs, day separators, centred lifecycle lines, amber internal notes).
> - **Trengo theme + missing folders/pane (full fidelity pass)** — adopted Trengo's look in the comms centre: a **dark folder rail with a mint-teal accent** (new `trengo` colour token, a scoped §4 exception used only under `inbox/*`). Added the folders Trengo has that we lacked — **Spam** (`ConversationStatus.spam`, CRM-side, `setSpam` + bulk `markSpam`), **Mentioned** (derived from note @mentions), **Favorites** (per-user `ConversationFavorite` star, toggled from the thread header, shown on rows) — plus folder counts for each. The right context pane gained Trengo-style **contact custom fields** and clickable **previous conversations** (`inbox.conversations.context`). Schema: `ConversationFavorite` + the `spam` enum value (migration `20260620140000`).
> - **Teams + Views folders (remaining rail taxonomy)** — the rail now has Trengo's **Teams** section (`inbox.conversations.teams`: the teams a user can see — managers see all, others their own — each with a count of open conversations assigned to its members; selecting one filters via `list({teamId})`) and **Views** (per-user saved filters — `ConversationView` + `inbox.conversations.views.{list,create,delete}`; "+" saves the current folder+channel+label combo, click re-applies, × deletes). Migration `20260620160000`. The only Trengo rail item still CRM-side rather than pushed to Trengo is Spam (Trengo owns its own spam classification; no documented spam API, so we do not guess one — §44).
> - **Status reconcile cron** (Phase 7, the safety net) — `trengo/reconcile-status` (`packages/integrations/trengo/src/reconcile.ts`, every 15 min) re-fetches each Conversation's CURRENT state from Trengo (oldest-checked-first via the new `Conversation.lastSyncCheckAt` cursor, 50/tick) and re-converges status / assignee / labels through the same monotonic merger the webhook uses. This closes the **live-drift** gap below: until now, a Trengo workspace that did not subscribe the lifecycle events (or dropped a delivery) left the head stuck — "tickets still open here that are closed on Trengo" — and only the **manual** "Last 7 days (quick sync)" import re-converged it. The cron makes re-convergence automatic and continuous (golden rule #4). Status flips audit `trengo.status_reconciled`; a Trengo-deleted ticket leaves the head untouched (§3) and just advances the cursor.

This is a full audit of the StudyMind CRM as it relates to Trengo, plus the
architecture and phased plan to make the CRM a complete operational layer on
top of Trengo with real-time two-way synchronisation — **without** forcing
staff out of Trengo and **without** duplicating systems we already have.

The guiding constraint from the brief, and from CLAUDE.md §3/§35, is preserved
throughout: **reuse before rebuild, do not duplicate data, improve the existing
integration before creating new ones.**

---

## 1. Executive summary

The Trengo integration is **real and well-built**, not a stub. The inbound
half of the loop (Trengo → CRM) is production-grade: signature-verified
webhook, idempotent `ProviderEvent`, Inngest job with 6 retries, per-agent
KMS-encrypted tokens, a 90-day historic backfill, and a per-contact channel
view-model that already groups conversations by ticket and surfaces the
WhatsApp 24-hour window.

The gaps are concentrated in four areas:

1. **Outbound (CRM → Trengo) is almost entirely unwired.** The outbound
   `sendMessage` exists and is audited, but the only caller was the card
   call-summary fan-out. There was **no way to reply to a conversation from the
   CRM**, and the `assignTicket` / `closeTicket` client methods are dead code.
   _(Partially closed in this PR — see §13.)_
2. **No first-class conversation entity.** Everything is flattened into the
   polymorphic `Interaction` table. There is no queryable row that holds a
   conversation's _current_ status / assignee / unread state, so the "inbox"
   is a flat list of inbound messages and assignment/close/label events become
   immutable timeline rows rather than state transitions.
3. **No real-time transport.** Updates rely on TanStack Query polling
   (5 s on the backfill banner, 30 s on the notification bell). There is no
   SSE / WebSocket push.
4. **Sync is one-directional and message-only.** Contact-field edits, tags,
   and assignment changes made in Trengo do not update the CRM beyond writing a
   timeline `Interaction`; nothing made in the CRM (other than a sent message)
   flows back to Trengo.

None of these require throwing anything away. They are additive layers on top
of solid foundations.

---

## 2. Existing feature inventory (CRM)

Mature, working surfaces (tRPC + UI both present):

| Area                                                           | tRPC                     | UI                                |
| -------------------------------------------------------------- | ------------------------ | --------------------------------- |
| Contacts (CRUD, merge, bulk, links, docs, channels)            | `contact.*`              | `/contacts`, `/contacts/[id]`     |
| Families + dynamic pipeline                                    | `family.*`, `pipeline.*` | `/contacts/families`, `/pipeline` |
| Boards / cards / labels / subjects (ADR 0018)                  | `board.*`                | `/boards`                         |
| Leads                                                          | (created by webhooks)    | inbox triage                      |
| Tasks (+ comments)                                             | `task.*`                 | `/tasks`                          |
| B2B accounts (schools / partnerships) + students               | `businessAccount.*`      | `/accounts`                       |
| Finance (refunds, payment links, discrepancies)                | `finance.*`              | `/finance`                        |
| Reports (finance, aircall, cost, ops, retention)               | `reports.*`              | `/reports`                        |
| Dashboard                                                      | `dashboard.summary`      | `/`                               |
| Inbox (inbound triage)                                         | `inbox.*`                | `/inbox`                          |
| Notifications bell                                             | `notifications.list`     | shell bell                        |
| Settings (users, teams, integrations, branding, forwarding, …) | various                  | `/settings/*`                     |
| Account → Trengo connect                                       | `account.trengo.connect` | `/account/trengo/connect`         |

~20 tRPC routers, ~100+ procedures. RBAC is canonical 5-role (ADR 0014),
enforced in procedures via `apps/web/lib/trpc/builders.ts` and
`packages/core/auth/policies.ts`.

---

## 3. Existing Trengo integration inventory

`packages/integrations/trengo/src/`:

| File              | Responsibility                                                                                                                     | State                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `webhook.ts`      | HMAC-SHA-256 verify (`x-trengo-signature`), constant-time compare, envelope parse                                                  | **Fully functional**                  |
| `types.ts`        | Channel enum, event-name normalisation (dotted + underscored aliases), envelope types                                              | **Fully functional**                  |
| `client.ts`       | Per-agent client factory; KMS-decrypts token JIT; `sendMessage`, `assignTicket`, `closeTicket`, `request`                          | Send used; **assign/close dead**      |
| `outbound.ts`     | Audited `sendMessage` — two-phase `pending_send`→`sent`, idempotent on `requestId`, embeds `interactionId`/`agentId` custom fields | **Fully functional**                  |
| `connect.ts`      | Validate token via `/me`, envelope-encrypt, upsert `TrengoToken`, 90-day expiry                                                    | **Fully functional**                  |
| `jobs.ts`         | Inngest `trengo/event.received`: match contact → upsert `Interaction` → audit; creates `Lead` on unmatched inbound                 | **Functional (message-centric)**      |
| `backfill.ts`     | Inngest `trengo/backfill.requested`: 90-day history on first connect, idempotent on Trengo message id                              | **Functional**                        |
| `events/index.ts` | Handler registry                                                                                                                   | **Stub** (`HANDLED_EVENT_TYPES = []`) |

Webhook route: `apps/web/app/api/webhooks/trengo/route.ts` — verify → `upsertProviderEvent` (idempotent on `(provider, eventId)`) → `inngest.send` → 200. Matches the CLAUDE.md §7.1 pattern exactly.

Surfacing: `apps/web/lib/view-models/contact-channels.ts` →
`trengoConversationsForContact` groups `message`/`ticket_*`/`label_*`
Interactions by `payload.ticketId`, derives `ticketStatus`, and computes the
WhatsApp 24h `replyDeadlineAt`. Exposed via `contact.channels.trengoConversations`
and rendered by `contacts/[id]/sections/TrengoSection.tsx`.

Supporting infra confirmed production-ready: `safeFetch` allowlists
`app.trengo.com` / `*.trengo.com`; `ProviderEvent` dedupe handles the
`findUnique`→`create` race via the unique index (P2002); Inngest retries 6×
with native dead-letter.

---

## 4. Gap analysis (Fully / Partial / Missing / Debt)

### Fully functional

- Inbound webhook ingestion (verify, dedupe, enqueue, retry).
- Per-agent token storage + rotation expiry + fail-closed outbound.
- 90-day backfill on connect.
- Per-contact conversation grouping + WhatsApp window.
- Outbound `sendMessage` primitive (audited, idempotent, two-phase).

### Partially functional (need completion)

- **Inbox** (`/inbox`): flat list of `message.inbound` rows. `assign`/`snooze`
  write into `Interaction.payload` but **the list never filters on them** — so
  snooze is cosmetic and assignment is invisible in the list.
- **Notifications**: sourced from `AuditLogEntry`; "unread" is the heuristic
  `actorId !== user.id`. The referenced `notificationsSeenAt` column **does not
  exist** and there is no `markSeen` mutation. New inbound messages do not
  generate a notification of their own.
- **AI draft reply** (`interaction.draftReply`): drafts WhatsApp/SMS/web-chat —
  but until this PR there was **no send** for those channels.

### Missing

- **First-class conversation/ticket entity** (status, assignee, unread,
  lastMessageAt, tags as queryable columns).
- **Real-time transport** (SSE/WebSocket). Polling only.
- **CRM → Trengo for non-message actions**: assign, close/reopen, tag — none
  flow back to Trengo. (`assignTicket`/`closeTicket` exist but are unused.)
- **Trengo → CRM contact-field & tag sync**: `contact.updated` / tag events are
  not consumed to update `Contact`; only message events become Interactions.
- **Trengo user ↔ CRM user mapping**: `assignee_id` in a webhook cannot be
  resolved to a `User`; `User` has no `trengoUserId`.
- **Attachments**: backfill/webhook capture `body` only, not message media.
- **Outbound resilience queue** for sustained Trengo downtime (today: manual
  retry from `pending_send`).
- **Redis**: not wired; rate limiter is in-memory with a Redis TODO.

### Technical debt

- **Event-taxonomy drift**: `ticket_assigned/closed/reopened`,
  `label_added/removed` are in the Prisma `InteractionType` enum and written by
  the job, but were absent from `INTERACTION_TYPES` in
  `packages/core/src/events/registry.ts`. _(Fixed in this PR.)_
- **Duplicated conversation lookup**: the "find the contact's active ticket"
  logic was inline in the card call-summary sender. _(Extracted to a shared
  resolver in this PR.)_
- **JSON-stored inbox state** (`inboxAssigneeId`, `inboxSnoozedUntil`,
  `pending_send`) is not indexable — fine at small scale, a problem for a real
  inbox at volume.
- **Single-contact matching**: `findFirst` by phone then email; the §11
  shared-family-line case ("attach to Family, prompt to assign") is not
  handled.
- **Outbound can only reply to an existing ticket**, not open a new
  conversation (Trengo ticket-create API is not wired).

---

## 5. Architecture review

The integration honours the CLAUDE.md contracts: thin webhook handler, raw
payload to `ProviderEvent`, refetch-not-trust, all real work in Inngest,
per-agent attribution, audited writes, KMS at rest, module boundaries
(`integrations` never imports `apps/web`).

The **one structural decision worth revisiting** is _conversation-as-Interaction_.
It was the right call for a timeline, but an operational inbox needs a
conversation **head**: a row whose columns are the current status / assignee /
unread / last-activity / tags, updated in place by each webhook. Without it,
every inbox read re-derives state by scanning up to ~400 Interaction rows per
contact and cannot answer cross-contact questions ("all unassigned open
WhatsApp conversations") with an index.

The recommendation (detailed in ADR 0020) is a **lightweight `Conversation`
head that references, not duplicates, the message bodies already in
`Interaction`.** Messages stay where they are; the head is the missing index.
This satisfies "do not duplicate data".

---

## 6. Database review

- `Interaction` — polymorphic, `payload` JSONB, partial indexes on
  `(contactId,type,occurredAt) WHERE deletedAt IS NULL`,
  `(payload->>'gmailThreadId')`, and `(payload->>'ticketId')`
  (migration `20260524150000`). Good coverage for current reads.
- `TrengoToken` — per-agent, KMS envelope columns, `expiresAt` indexed.
- `ProviderEvent` — `@@unique([provider, eventId])`, `processedAt`.
- `Lead` — created on unmatched inbound; `source`, `rawPayload`, phone/email.
- **Absent**: any `Conversation`/`Message` head; any `Notification` table; any
  `trengoUserId` on `User`; any contact-level `Tag` model (labels are
  board-only via `CardLabel`).

Proposed additive, forward-only changes (two-PR schema-then-backfill per §19.1):
`Conversation` (+ `ConversationParticipant` optional), `User.trengoUserId`,
`User.notificationsSeenAt`, and either a `Notification` table or a documented
decision to keep deriving from `AuditLogEntry`.

---

## 7. Synchronisation architecture (target)

A single **Trengo Integration Layer** (the existing `packages/integrations/trengo`
package, extended) owns every read/write to Trengo. No scattered `fetch` calls.

```
Trengo  ──webhook──▶ /api/webhooks/trengo ──▶ ProviderEvent ──▶ inngest:trengo/event.received
                                                                      │
                                                  upsert Conversation head + Interaction(s)
                                                                      │
                                                          emit crm change  ──▶ SSE ──▶ browser
CRM UI ──tRPC(conversation.*)──▶ outbound.ts ──▶ Trengo API
            (reply / assign / close / tag)            │
                          writes Interaction + updates Conversation head; embeds
                          interactionId custom-field so the echoed webhook dedupes
```

**Loop-prevention** (already partially present): outbound embeds
`custom_fields.interactionId`; the inbound job skips
`message.outbound` events that carry an `interactionId` we created
(`jobs.ts` "self_sent_mirror"). The same trick generalises to assign/close/tag
echoes via a short-lived `(entity, action, hash)` marker.

**Idempotency** stays the contract end-to-end: `ProviderEvent (provider,eventId)`
inbound, `requestId`/`outboundRequestId` outbound.

---

## 8. Webhook architecture (target)

Keep the §7.1 handler shape. Extend coverage in the **job**, not the route:

- `message.inbound` / `message.outbound` → Interaction (+ conversation head),
  with **attachment capture** to S3 (reuse `packages/integrations/gmail/src/s3.ts`
  pattern).
- `ticket.assigned` → set `Conversation.assigneeUserId` (resolve via
  `User.trengoUserId`), write transition Interaction.
- `ticket.closed` / `ticket.reopened` → set `Conversation.status`.
- `label.added` / `label.removed` → maintain conversation/contact tags.
- `contact.updated` (new) → **suggest** field changes (never silent-merge per
  §3); surface as a review item, not an auto-write.

Each remains idempotent and audited; unrecognised events are logged + marked
processed (the existing pattern).

---

## 9–12. Communication Centre, notifications, performance, security, resilience

- **Communication Centre**: upgrade `/inbox` into a two-pane conversation list
  - thread view, reading the new `Conversation` head (filters: assigned /
    unassigned / open / closed / unread / channel; saved views via URL state per
    §26). Thread view reuses `contact-channels` message shapes and the new reply
    path. Mobile-first, dense, Radix primitives (§28).
- **Notifications**: add `User.notificationsSeenAt` + `notifications.markSeen`;
  emit a notification on new inbound / assignment / mention / reopen; add
  browser notifications via the Notification API gated on permission.
- **Performance**: conversation head makes the inbox a single indexed query;
  cursor pagination (§27) already the norm; wire Redis for the rate limiter and
  a response cache when multi-instance; lazy-load thread bodies.
- **Security**: unchanged contracts — signature verify, per-agent KMS tokens,
  RBAC in procedures, audited writes, `safeFetch` allowlist. New procedures
  inherit `auditedProcedure` + rate limits.
- **Resilience**: add an outbound retry queue (Inngest function reading
  `pending_send` Interactions / a small `OutboundMessageIntent`) so a Trengo
  outage drains automatically instead of relying on manual retry; alert ops via
  the existing PagerDuty/Slack paths.

---

## 13. What shipped in this PR (first, reuse-first increment)

Foundational, no schema migration, fully typed + tested:

1. **`interaction.trengo.reply`** (`apps/web/app/api/trpc/routers/interaction.ts`)
   — reply to a contact's active Trengo conversation from the CRM. Reuses the
   existing audited `sendMessage`. RBAC mirrors `email.reply` (Virtual
   Assistant cannot send). TOKEN_EXPIRED → friendly FORBIDDEN; transient Trengo
   errors → recoverable BAD_REQUEST (the Interaction stays `pending_send`).
2. **Shared resolver** `resolveActiveTrengoConversation`
   (`packages/integrations/trengo/src/conversations.ts`) — one definition of
   "the contact's active ticket + channel", now used by both the reply path and
   the card call-summary sender (**removed a duplicate**).
3. **Draft panel can send** (`components/contact/draft-reply-panel.tsx`) — the
   "review before sending" draft now has a real **Send via WhatsApp/SMS/Web
   chat** button for Trengo channels.
4. **Event-taxonomy fixes** (`packages/core/src/events/registry.ts`) — added the
   five Trengo lifecycle `INTERACTION_TYPES` (drift fix) and a
   `trengo.reply_requested` audit event.

Verification: `vitest` (4 new + existing pass), `tsc` clean across
core/trengo/web, ESLint clean (incl. custom `require-audit` /
`registered-event-names`).

This closes the single biggest functional gap (no CRM→Trengo reply) and lays
the outbound foundation every later phase builds on, while touching no money,
no schema, and no irreversible state.

---

## 14. Testing plan (for the larger build)

- **Unit**: resolver done; add reducers for conversation-head state machine.
- **Webhook contract tests**: extend `__tests__/contract/trengo.test.ts` with
  fixtures for assigned/closed/reopened/label/contact.updated, each with an
  `expected.json` (the repo's replay-corpus pattern, §23.1).
- **Integration** (Testcontainers): conversation head upsert idempotency;
  outbound dedupe on echoed webhook.
- **E2E** (Playwright): reply-from-inbox, assign, close — the §23 critical-flow
  list extended.
- **Loop test**: send from CRM → assert the echoed `message.outbound` webhook is
  skipped (no duplicate Interaction).

## 15. Deployment plan

Forward-only migrations in two PRs each (schema, then backfill job) per §19.1.
SSE endpoint is a new `app/api/realtime` route (nodejs runtime); no new infra
beyond Redis (already a Railway plugin) when we move the rate limiter and add a
pub/sub fan-out for multi-instance SSE. Feature-flag the Communication Centre
(`comm_centre_enabled`) so Trengo-first staff are unaffected during rollout.

---

## Phased roadmap (recommended order)

1. **Outbound foundation** — _this PR_ + reply-from-inbox + assign/close from
   CRM (wire the dead `assignTicket`/`closeTicket`).
2. **Conversation head** — additive `Conversation` model + webhook job upserts
   state; inbox reads it.
3. **Real-time** — SSE channel; browser updates without refresh.
4. **Communication Centre** — two-pane inbox + thread view + filters/saved views.
5. **Notifications** — seen-state, new-message events, browser notifications.
6. **Full sync** — tags, contact-field suggestions, `trengoUserId` mapping,
   attachments.
7. **Resilience & scale** — outbound retry queue, Redis rate limiter/cache.

Each phase is independently shippable and leaves Trengo-first staff fully
functional throughout.
