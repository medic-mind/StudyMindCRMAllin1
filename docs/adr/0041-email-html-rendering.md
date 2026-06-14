# ADR 0041 — Rendering email HTML in the reading pane (Communications Hub)

Status: Accepted
Date: 2026-06-13
Context: ADR 0021 (Communications Hub), CLAUDE.md §14, §44.2

## Context

The `/mail` client and the comms-centre rendered every email body as flattened
plaintext (`apps/web/lib/format/html-text.ts`), a deliberate stop-gap that
avoided taking a dependency on an HTML sanitiser "without an ADR". The result
looked nothing like Gmail: no formatting, no tables, no inline images, no
branded HTML newsletters. The top-priority initiative (§1) is a Gmail-class
client that looks identical to Gmail, so we need to render the real HTML.

The hard part is safety: email HTML is fully attacker-controlled (anyone can
email a connected inbox). Rendering it naively is an XSS hole. The app also runs
a strict, nonce-based CSP with **no `unsafe-inline`** (`apps/web/lib/security/csp.ts`),
which would strip the inline `style="…"` attributes that email HTML depends on
if the content shared our origin.

## Decision

Render the message HTML inside a **locked, opaque-origin sandboxed iframe**.

- `sandbox` is set **without `allow-scripts`** → no script in the email can ever
  execute. This is the primary XSS control and it is absolute.
- `sandbox` is set **without `allow-same-origin`** → the frame is a unique
  opaque origin. It cannot read our cookies or DOM, and — crucially — it does
  **not inherit our strict CSP**, so the email's inline styles render and it
  looks exactly as it does in Gmail.
- `allow-popups` + a `<base target="_blank">` in the document lets links open in
  a new tab.
- The body is delivered via `srcDoc` (no network fetch, no blob lifecycle).

Defence in depth, even though the sandbox already neutralises scripts:

- Server-side, the synced HTML is run through `sanitizeEmailHtml`
  (`packages/core/src/mail/html-email.ts`): strip `<script>`, `<iframe>`,
  `<object>`/`<embed>`/`<applet>`, `<base>`/`<meta>`/`<link>`, inline `on*=`
  handlers, and `javascript:` URLs. Inline styles, tables, images and links are
  intentionally **kept**.
- `prepareEmailHtml` caps the body at 512 KB; anything larger stores no HTML and
  the reading pane falls back to the plaintext body.

A per-message **"View plain text" toggle** is always available, so a blocked or
ugly render is never a dead end.

## Data flow

1. `normaliseMessage` (Gmail client) now extracts the `text/html` part into
   `GmailMessage.htmlBody`.
2. `processMessage` stores `prepareEmailHtml(htmlBody)` as `payload.bodyHtml` on
   the `email_received` / `email_sent` Interaction (null when absent/oversized).
3. `inbox.conversations.get` surfaces `bodyHtml` per message.
4. `MailWorkspace`'s `EmailHtmlBody` renders it in the sandboxed iframe.

No new dependency is added — the sandbox attribute is the control, not a
third-party sanitiser. Inbound-only for now; HTML **compose/send** (a rich
editor producing `multipart/alternative`) is a follow-up that will reuse the
existing `system-send.ts` MIME builder.

## Consequences

- Email looks like Gmail (formatting, tables, images, branded HTML).
- Strong XSS posture: scripts cannot run; the frame cannot touch the app.
- Remote images load (no allow-list yet) — a tracking-pixel/privacy concern to
  revisit with a "block remote images" default, mirroring Gmail.
- Sandboxed iframes can't self-size without scripts, so the frame uses a fixed
  height with internal scroll. A height-negotiation pass is possible later via a
  one-off `allow-scripts` postMessage shim in a separate, audited iframe origin.
- The comms-centre thread view still flattens to text; migrating it to
  `EmailHtmlBody` is a fast follow.
