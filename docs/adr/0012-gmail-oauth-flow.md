# ADR 0012: Per-agent Gmail OAuth flow with KMS-encrypted refresh tokens

- Status: Accepted
- Date: 2026-05-10
- Affects: CLAUDE.md §14 (Gmail playbook)

## Context

Slice 7 introduced the `packages/integrations/gmail` client with the Pub/Sub
`watch` and history-sync mechanics in place, but it stubbed the OAuth handshake
and assumed refresh tokens would arrive via fixture. Production needs a real
per-agent consent flow:

- Each ops agent connects their own Gmail mailbox so sent items reflect their
  identity (CLAUDE.md §11 same principle as Trengo per-agent tokens).
- Refresh tokens are long-lived, sensitive credentials. They cannot live in
  plaintext in Postgres or in logs.
- The flow must be revocable end-to-end: disconnect must revoke at Google,
  stop the Pub/Sub watch, and crypto-shred the stored refresh token.

## Decision

Implement a standard OAuth 2.0 web flow scoped per user, with refresh tokens
stored as `EncryptedField` rows under our existing AWS KMS envelope encryption
(CLAUDE.md §21.1).

- **Scopes.** `https://www.googleapis.com/auth/gmail.readonly`,
  `gmail.send`, `gmail.modify`. No `https://mail.google.com/` full-access
  scope. No drive, calendar, or contacts.
- **Consent endpoint.** `GET /api/oauth/gmail/connect` builds the Google
  consent URL with `access_type=offline`, `prompt=consent`, and a single-use
  `state` token. The `state` token (cuid2) is stored in a new `OAuthState`
  table with `userId`, `provider='gmail'`, `expiresAt = now + 5 minutes`.
- **Callback endpoint.** `GET /api/oauth/gmail/callback` verifies the
  `state` against the table (single use, not expired, bound to the signed-in
  user), exchanges the `code` for `{access_token, refresh_token, ...}`, and
  encrypts the refresh token via `encryptField(refreshToken, { userId,
  purpose: 'gmail_refresh_token' })`. The ciphertext is persisted on
  `User.gmailRefreshTokenCipherId`.
- **Watch setup.** Immediately after token storage, the callback calls the
  Slice 7 `setupWatch(userId)` helper which calls `users.watch` and persists
  the resulting `historyId` and `expiration` to `User.gmailWatchExpiresAt`.
  The recurring `gmail/refresh-watch` job (CLAUDE.md §17.1) renews on the
  6-day cadence.
- **Disconnect.** A tRPC mutation `oauth.gmail.disconnect` calls Google's
  revoke endpoint with the access token (which invalidates the refresh
  token), calls `stopWatch(userId)`, deletes the `EncryptedField` row, and
  clears `User.gmailWatchExpiresAt`. Audited as `gmail.connection_revoked`.
- **Failure handling.** When Google returns `invalid_grant` during a
  background refresh, the client marks `User.gmailConnectionStatus =
  'needs_reconnect'`. The CRM layout shows a banner to that user prompting
  reconnect. The Pub/Sub watch is stopped so we do not pile up failed
  history syncs.

## Consequences

- We never log or surface refresh tokens. Decryption is centralised in
  `packages/core/safeguarding/decrypt.ts` with audit on every read.
- Disconnect is genuinely reversible — no leftover Google-side authorisation
  after revoke.
- Each agent's mailbox is independently connected and independently
  revocable.

## Alternatives considered

- **Service account with domain-wide delegation.** Rejected: requires
  Workspace admin consent, breaks per-agent identity, and gives the CRM a
  blast-radius equal to the entire domain.
- **Storing refresh tokens in Postgres `text` columns.** Rejected on §21.1
  grounds; refresh tokens are credentials, treat them as such.
