# ADR 0021 — Communications Hub (multi-account email operating system)

- Status: Proposed (Phases 1–2 Accepted & implemented: multi-account foundation; `MailSyncProvider` seam)
- Date: 2026-05-30
- Supersedes: none
- Related: ADR 0012 (Gmail OAuth), ADR 0017 (comprehensive customer view + backfill), ADR 0020 (CRM as the operational layer on top of Trengo), CLAUDE.md §14

## Context

The brief reframes the highest-value work as an **Email & Communications
Operating System**, not another CRM. The target: staff can spend the whole day
inside the CRM and never open Gmail — and if they do open Gmail, both stay
perfectly in step. The CRM and the mailbox become two interfaces onto the same
data.

Concretely the brief asks for:

- **Multi-account, multi-provider.** No practical limit on connected inboxes
  (`info@`, `admissions@`, `sales@`, personal mailboxes, …) across Gmail,
  Google Workspace, Outlook 365, Microsoft Exchange and IMAP.
- **True two-way sync** — not logging. New mail, sent, replies, forwards,
  drafts, read/unread, labels, folders, stars, archive, delete, spam,
  threading; mirrored in both directions in near-real-time.
- **A full email client** (inbox/sent/drafts/archive/spam/trash, search, bulk
  actions, keyboard shortcuts, thread + preview pane) — Gmail/Superhuman class.
- **Shared team inboxes** with assign / claim / transfer / internal notes /
  @mentions / task creation; internal notes never reach the customer.
- **Auto-linking** of every message to the existing Lead / Contact / Family —
  no duplicate customer records — feeding the existing 360° timeline.
- Templates, automations, analytics, calendar (Google + Outlook), and a path to
  fold WhatsApp / Trengo / SMS / social into one unified conversation list.

### What already exists (we extend, we do not rebuild)

- **Gmail integration (Phase 1, ADR 0012).** Per-agent OAuth (refresh token in
  `EncryptedField`), Pub/Sub `watch` → `gmail/history.changed` Inngest job →
  many-to-many Contact match → `email_received` / `email_sent` `Interaction`
  rows; attachments streamed to S3; idempotent outbound reply via
  `OutboundEmailIntent`; 90-day backfill (ADR 0017); watch auto-renewal.
- **`GmailMailbox`** already states "multiple mailboxes can be connected per
  agent" — but it is Gmail-only and has no notion of a *shared* inbox.
- **`Conversation` head + Communication Centre + SSE (ADR 0020).** A first-class
  conversation state row, a `/inbox/conversations` list + thread view, and a
  live SSE transport (`/api/realtime/conversations`, in-process bus,
  `useConversationStream`). **Today it is keyed on `trengoTicketId` — email is
  not yet surfaced there.**
- **Per-contact channel view-models** already group email by `gmailThreadId`
  (`contact.channels.emailThreads`).

Two CLAUDE.md constraints frame every choice, exactly as in ADR 0020: **never
silently mutate data** (§3 — AI/automation suggests, humans confirm) and **do
not duplicate systems or data** (§35 — the conversation head references
`Interaction` bodies, it does not copy them).

## Decision

Build the Communications Hub as **additive layers on the existing Gmail
integration and the ADR 0020 conversation/realtime substrate**, behind a
provider-agnostic seam so Outlook/Exchange/IMAP slot in without touching the
domain. Each phase is independently shippable.

### Phase 1 — Multi-account foundation (this PR)

Introduce a **provider-agnostic `MailAccount`** as the unit of "a connected
inbox", generalising the Gmail-only `GmailMailbox`:

- `provider ∈ { gmail, google_workspace, outlook, exchange, imap }`.
- `ownerKind ∈ { personal, shared }` — *personal* belongs to one agent;
  *shared* is a team inbox accessed by many (`info@`, `admissions@`, …).
- `status ∈ { connected, needs_reconnect, disconnected, error }`.
- Generic sync state (`syncCursor`, `watchExpiresAt`, `lastSyncedAt`) that each
  provider interprets in its own terms (Gmail `historyId`, Graph `deltaToken`,
  IMAP UID) — no provider type leaks into the column set.
- A **bridge** `gmailMailboxId` to the legacy `GmailMailbox`, so the hub reuses
  the live Gmail sync with **no destructive migration** (forward-only, §19.1).
  `mailAccount.syncFromGmail` materialises the caller's existing `GmailMailbox`
  rows as personal `MailAccount`s idempotently — reuse, not rebuild.
- **`MailAccountMember`** (mirrors `TeamMember`) grants staff access to a shared
  inbox; an optional `teamId` ties a shared inbox to an ops `Team` (Admissions,
  Sales, …). Personal accounts need no member rows — the owner is implicit.
- **Secrets are never stored on `MailAccount`** — OAuth refresh tokens and IMAP
  passwords stay in `EncryptedField` (§21), same as Gmail today.
- A pure **provider capability registry** (`MAIL_PROVIDERS` in
  `packages/core/src/mail`) declares, per provider, the auth kind and which
  capabilities are live (send / read / push / labels / folders / threads /
  two-way). Only `gmail` is `connectable` today; the rest render as
  "coming soon" so the UI advertises the roadmap honestly and fails closed (§8).
- tRPC `mailAccount.*` (list / get / providers / createShared / update /
  setDefault / disconnect / members.* / syncFromGmail) with RBAC + per-row
  attribute checks; every write audited. A Settings → **Email accounts** surface
  lists personal + shared inboxes, imports connected Gmail, and (Manager+)
  creates shared inboxes and manages membership.

This phase ships no irreversible action and changes no existing Gmail code path.

### Phase 2 — Provider sync interface + Gmail behind it (implemented)

`MailSyncProvider` interface lives in `packages/core/src/mail/sync-provider.ts`
(type-only seam, no I/O — fits §5: `core` cannot import `integrations`). Gmail
implements it in `packages/integrations/gmail/src/mail-provider.ts` as a thin
pass-through to the existing `GmailClient` — no behaviour change. The runtime
dispatcher `apps/web/lib/mail/get-sync-provider.ts` resolves a `MailAccount.id`
to its provider and fails closed (`MailProviderUnavailableError`) for
non-connectable providers and disconnected accounts. Pointing the live
`gmail/history.changed` job at `MailAccount` is deferred to Phase 3 (when the
bridge is materialised by `syncFromGmail`).

### Phase 3 — Unified inbox (email into the Conversation head)

Generalise `Conversation` beyond Trengo (`provider` + nullable external ids,
`mailAccountId`), upsert an email thread → conversation head on every synced
message, and surface email alongside Trengo in the Communication Centre with the
existing SSE transport. Auto-link to Lead/Contact/Family reuses the current
many-to-many matcher; **unmatched mail creates a `Lead`, never a ghost Contact**
(§11 rule, applied to email).

### Phase 4 — Full email client

`/mail` two/three-pane workspace: account switcher (all accounts the agent can
see), folder/label rail, thread list with multi-select + bulk actions, thread +
preview pane, command-palette search, keyboard shortcuts. RSC list + view-model
shapers; mutations through tRPC.

### Phase 5 — Two-way action sync

Mirror read/unread, archive, star, label/folder, delete and drafts in **both**
directions (Gmail `users.messages.modify` / drafts; Graph equivalents).
Idempotent, echo-protected (our own writes are skipped on the inbound side,
exactly like the Trengo `interactionId` echo guard), audited.

### Phase 6 — Shared-inbox operations

Assign / claim / transfer a conversation within a shared inbox; internal notes
and @mentions (never sent outbound); one-click task creation. Reuses the ADR
0020 assignee/notification plumbing.

### Phase 7 — Outlook / Exchange / IMAP

New `MailSyncProvider` implementations behind the Phase-2 seam. Microsoft Graph
(delta query + change notifications) for Outlook/Exchange; an IMAP/SMTP provider
for everything else. **Requires its own ADR** for the new dependencies (§3).

### Phase 8 — Templates, automations, analytics, calendar, unified channels

Brand-aware templates with variables; trigger→action automations (suggest-then-
confirm for anything customer-facing, §3); per-user/team/brand analytics; Google
+ Outlook calendar two-way; and folding WhatsApp/Trengo/SMS/social into the same
conversation list (Trengo already lives in the head — this extends the pattern).

## Alternatives rejected

- **A new "mail" store that copies message bodies.** Rejected (§35): we already
  store bodies in `Interaction`. `MailAccount` is account state; the future
  conversation head references `Interaction`, it does not duplicate it.
- **Extending `GmailMailbox` in place.** Rejected: bakes Gmail assumptions
  (`historyId`, `topicName`) into the cross-provider unit and offers no seam for
  shared inboxes or Outlook/IMAP. `MailAccount` is provider-agnostic; the bridge
  keeps Gmail working with no rewrite.
- **A third-party unified-inbox SaaS / email API (Nylas, etc.).** Deferred: it
  is a BaaS-shaped dependency (§35 spirit), moves PII for minors and LAs through
  a third party (§21), and would need its own ADR. We own the providers.
- **One giant migration that moves Gmail data onto `MailAccount` now.** Rejected
  per §19.1 — schema add and data backfill are separate PRs. Phase 1 adds the
  tables and an idempotent import; flipping the sync over is Phase 2.

## Consequences

- Phase 1 ships a real, audited, RBAC-gated multi-account surface with **zero
  change to the working Gmail sync** and no irreversible action.
- `MailAccount` becomes the single unit every later phase hangs off (sync,
  client UI, shared-inbox ops, new providers).
- New providers are an ADR + a `MailSyncProvider` implementation — the domain,
  the schema, the UI and the audit story do not move.
- "No silent mutation" carries forward: inbound contact-field changes and
  automations are surfaced for confirmation, not auto-applied.
- The legacy `GmailMailbox` is retained (forward-only). A later PR backfills
  `MailAccount` from it and retires the column once the sync reads `MailAccount`.
