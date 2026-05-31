# ADR 0022 — Internal team messaging (Slack-style staff chat)

- Status: Accepted
- Date: 2026-06-03
- Deciders: Tech lead, Product owner

## Context

The team juggles Slack for internal chatter while every customer fact lives in
the CRM. When an agent wants to discuss a family, they copy a name or a link
into Slack, losing the connection back to the record. We want an internal
messaging surface *inside* the CRM so staff can talk in channels, DM each
other, thread replies, @mention teammates, and — crucially — reference a
Contact / Family / Card / Task inline so the conversation stays connected to the
data it is about.

This is **staff↔staff** communication. It is not a customer channel (that is
Trengo/Gmail/Aircall, §10–§15) and it is not the customer timeline. We must not
conflate the two.

## Decision

Add a first-class messaging domain (`packages/core/src/chat/`) with its own
tables and a `chat.*` tRPC namespace, surfaced at `/messages`.

### Data model (`20260603180000_add_team_chat`)

- `ChatChannel` — `public | private | dm`. One seeded `#general` (singleton id
  `seed-chat-general`). DMs dedupe on a sorted-member `dmKey`.
- `ChatChannelMember` — membership + per-member read state (`lastReadAt`),
  notification preference (`all | mentions | none`), mute, and `member | admin`
  role.
- `ChatMessage` — body stored verbatim with inline tokens (see grammar);
  two-level threading via `parentId` (a reply always attaches to the thread
  root, never to another reply, exactly like Slack); denormalised
  `replyCount` / `lastReplyAt` on the root for cheap thread previews; soft
  delete via `deletedAt`.
- `ChatMention` — one row per @mentioned user per message, with its own
  `readAt`, so the "@mentions" badge moves independently of channel-unread.
- `ChatMessageRef` — polymorphic inline reference to a CRM entity
  (`contact | family | card | task`), indexed by `(refType, refId)` so
  "every message about this customer" is a single index hit.
- `ChatReaction` — emoji reactions, unique per `(message, user, emoji)`.

### Message body grammar (`packages/core/src/chat/parse.ts`)

Stored verbatim, Slack-inspired, and shared by the server extractor and the
browser renderer (the only client-safe chat module, exported as
`@studymind/core/chat/parse`):

- `<@USERID>` — a teammate mention.
- `<~TYPE:ID>` — a CRM-entity reference.
- Everything else is plain text.

The server re-extracts mentions and refs from the body on every send/edit, so
the `ChatMention` / `ChatMessageRef` rows can never drift from the rendered
message.

### RBAC (§20)

- Reading, posting, replying, reacting, mentioning, referencing, and opening
  DMs: **any authenticated staff member** (including `virtual_assistant`) — chat
  is a collaboration surface.
- Creating / renaming / archiving channels and managing membership:
  **Manager and above** (mirrors team + board management).
- Deleting another person's message: Manager+ (authors can always delete their
  own).

### Audit (§27, §45.2)

Channel administration (create / update / archive / restore / member add+remove)
is audited (`chat.channel_*`, `chat.member_*`). Individual messages are
deliberately **not** written to the compliance `AuditLogEntry` or the customer
`Interaction` timeline: they are high-volume staff chat with no
compliance/timeline value, and mixing them into the 7-year audit log or a
customer's history would be both noisy and wrong. The chat tables are
intentionally excluded from the ESLint `require-audit` sensitive-model set, so
message mutations correctly use `protectedProcedure` rather than
`auditedProcedure`.

### Real-time

v1 uses TanStack Query polling (active channel every few seconds; unread badges
on a slower cadence). This needs no new infrastructure and is honest about its
freshness. A push transport (SSE on the existing Redis, like the Trengo comms
centre roadmap in ADR 0020) is **Phase 2** and will reuse this same data model —
only the delivery changes.

## Alternatives considered

- **Keep using Slack.** Rejected: the whole point is to keep the conversation
  connected to the CRM record. We already ingest a *summary* from Slack
  (ADR 0011); that is for customer-relevant summaries, not team chat.
- **Reuse the polymorphic `Interaction` table.** Rejected: messages are not
  customer-timeline events; overloading `Interaction` would pollute every
  contact timeline query and the retention/DSAR machinery, and the read
  patterns (channel feed, threads, unread, mentions) want their own indexes.
- **contenteditable chip composer.** Deferred: a textarea with inline `@`
  autocomplete + a reference picker gives 90% of the UX at a fraction of the
  complexity and accessibility risk. Tokens are resolved to chips on render.

## Consequences

- A new top-level `/messages` workspace and a sidebar entry under "Work".
- New event names under the `chat.*` namespace in the registry.
- Forward-only migration; `#general` seeded for every environment.
- Future: SSE push, message search, file attachments (reuse the S3 +
  `EncryptedField` primitives), `@here`/`@channel` sentinels, and pinning.
