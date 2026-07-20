// Strict, nonce-based Content Security Policy builder. CLAUDE.md §44.2.
//
// SCRIPTS are locked down: `'nonce-<per-request>' 'strict-dynamic'`, no
// `unsafe-inline`, no `unsafe-eval`. That is the boundary that actually stops
// XSS — inline first-party scripts read the per-request nonce via `headers()`
// and emit it on the script tag.
//
// STYLES allow `'unsafe-inline'`. Blocking inline styles bought us little
// against a real adversary (a stripped stylesheet can redress the UI but not
// run code) while breaking any dependency that positions via inline styles —
// most visibly sonner, whose toaster container + per-toast stacking styles are
// injected inline, so under a nonce-only style policy the toasts fell out of
// their fixed bottom-right corner into a glitchy static stack. `'unsafe-inline'`
// and a nonce are mutually exclusive here: when a nonce is present browsers
// IGNORE `'unsafe-inline'`, so style-src carries no nonce. First-party CSS is
// still served from `'self'` stylesheets (globals.css / compiled Tailwind).
//
// Allowances are explicit and audited:
//   - Sentry (script, connect for the replay endpoint).
//   - Axiom HTTP ingest (connect).
//   - accounts.google.com (form-action target for the outbound Gmail OAuth
//     consent flow that lands in chunk 11 of ADR 0010).

export function buildCsp(nonce: string): string {
  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://*.sentry.io`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io https://api.axiom.co`,
    // `blob:` so the invoice-PDF preview can frame the bytes we fetch through our
    // own backend proxy as a blob URL (the proxy keeps the invoicing API key
    // server-side; a blob carries no X-Frame-Options/frame-ancestors so it is
    // not blocked by our own DENY headers). `frame-ancestors 'none'` below still
    // stops anyone framing *us*.
    `frame-src 'self' blob:`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self' https://accounts.google.com`,
    `upgrade-insecure-requests`,
  ]
  return directives.join('; ')
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
