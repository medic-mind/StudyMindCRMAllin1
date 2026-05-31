# ADR 0024 — Outlook 365 / Exchange / IMAP mail providers (Phase 7)

- Status: Proposed (design only — **no dependencies added yet**, pending approval)
- Date: 2026-05-31
- Related: ADR 0021 (Communications Hub), ADR 0012 (Gmail OAuth), CLAUDE.md §14, §21, §44

## Context

ADR 0021 Phase 1–5 delivered the multi-account foundation, the provider-agnostic
`MailSyncProvider` seam (`packages/core/src/mail/sync-provider.ts`), Gmail behind
it, email in the unified Conversation head, the `/mail` client, and two-way
action sync. The `MAIL_PROVIDERS` registry already advertises
`google_workspace | outlook | exchange | imap` as **not yet connectable**
(fails closed, §8).

Phase 7 makes those real. Per CLAUDE.md §3 ("No new dependency without an ADR")
this ADR is required *before* any package lands. It is written **design-first**:
the dependencies and OAuth apps below are **not** added until sign-off, sandbox
tenants, and secrets are in place.

## Decision

Implement each provider as a `MailSyncProvider` behind the existing seam — one
new `packages/integrations/<provider>/src/mail-provider.ts` + a `case` in the
dispatcher `apps/web/lib/mail/get-sync-provider.ts`. **No domain, schema, UI, or
audit changes** — that is the whole point of the Phase 2 seam. Flip
`connectable: true` in `MAIL_PROVIDERS` per provider as each ships.

### Outlook 365 + Exchange Online — Microsoft Graph

- **Auth.** Microsoft Entra (Azure AD) OAuth 2.0, delegated, granular scopes:
  `Mail.ReadWrite`, `Mail.Send`, `offline_access` (no `Mail.Read.All` /
  app-wide). Refresh tokens encrypted in `EncryptedField` exactly like Gmail —
  **never** on `MailAccount` (§21). A separate Entra app registration; client
  secret in Railway env mirrored from 1Password.
- **Read / sync.** `GET /me/messages/delta` (delta query) → opaque `deltaToken`
  stored in `MailAccount.syncCursor` (the seam already treats the cursor as an
  opaque string). Maps to `listChangesSince`.
- **Push.** Graph **change notifications**: `POST /subscriptions` with a webhook
  `notificationUrl` → `/api/webhooks/outlook`, max ~3-day expiry, renewed by a
  recurring job (mirrors `gmail/refresh-watch`). Subscription validation
  handshake echoes the `validationToken` (like Asana's `X-Hook-Secret`, §13).
  Maps to `setupPush` / `stopPush`.
- **Actions (Phase-5 parity).** `isRead` via PATCH; archive = move to the
  Archive well-known folder; delete = `POST /messages/{id}/move` to
  `deleteditems` (recoverable, mirrors Gmail Trash); flag/`STARRED` via the
  `flag` property; categories ≈ labels. Maps to `setReadState` / `setArchived` /
  `setTrashed` / `setStarred` / `modifyLabels` / `listLabels`.
- **Threading.** `conversationId` → `Conversation.externalThreadId`,
  `provider='outlook'`.
- **On-prem Exchange.** Same Graph provider when Exchange is hybrid-joined to
  Entra. Pure legacy on-prem (EWS) is out of scope unless a customer needs it;
  if so it is a separate `exchange` provider using EWS SOAP (poll only,
  `push:false` already in the registry).
- **Likely deps.** `@azure/msal-node` (token acquisition) + `fetch` for Graph
  REST (avoid the heavyweight `@microsoft/microsoft-graph-client` if a thin REST
  wrapper suffices). Decision deferred to implementation.

### Generic IMAP / SMTP

- **Auth.** Host/port/username + password or app-password. Credentials encrypted
  in `EncryptedField` (the non-secret host/port may sit in a small JSON on the
  account; **secret never on `MailAccount`**, §21). OAuth (XOAUTH2) supported
  where the host offers it.
- **Read / sync.** Poll on a schedule; `IDLE` where supported for near-real-time
  (`push:false` in the registry, so the unified inbox treats it as poll-backed).
  Cursor = `UIDVALIDITY:lastUID` in `syncCursor`.
- **Actions.** `\Seen` flag (read), move to Archive/Trash folders, `\Flagged`
  (star), IMAP keywords ≈ labels. SMTP for send.
- **Threading.** No native thread id — derive from `References` / `In-Reply-To`
  (`Message-ID` chain), already captured in our email `Interaction` payloads.
- **Likely deps.** `imapflow` (modern, promise-based IMAP) + `nodemailer` (SMTP).

### SSRF / security

Outbound to Graph/IMAP/SMTP hosts goes through the existing `safeFetch`
allowlist (§44.2); IMAP/SMTP hosts are user-supplied, so they are validated and
the connection is pinned to the configured host:port (no open relay). Graph
webhooks verify the subscription `clientState` we set at creation.

## Alternatives rejected

- **A unified-inbox SaaS (Nylas / Unipile).** Rejected (ADR 0021): BaaS-shaped
  dependency, routes minors' / LA data through a third party (§21), and still
  needs an ADR. We own the providers behind our own seam.
- **`@microsoft/microsoft-graph-client` mandatory.** Deferred: a thin REST +
  MSAL wrapper may keep the dependency surface smaller; decided at build time.
- **Storing IMAP passwords on `MailAccount`.** Rejected — secrets live in
  `EncryptedField` with crypto-shred on erasure (§21), same as every other
  provider token.

## Consequences

- Phase 7 is purely additive: new integration packages + dispatcher cases +
  webhook routes + a renewal job per push provider. The seam means the `/mail`
  client, the Conversation head, and the Phase-5 actions work unchanged the
  moment a provider reports `connectable`.
- Each provider needs its own sandbox tenant + OAuth app + secrets before code
  lands; this ADR gates that procurement.
- New dependencies (`@azure/msal-node`, `imapflow`, `nodemailer`, …) are added
  **only** once this ADR is accepted — tracked as a checklist at merge time.
