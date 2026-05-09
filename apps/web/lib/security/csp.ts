// Strict, nonce-based Content Security Policy builder. CLAUDE.md §44.2.
//
// No `unsafe-inline`, no `unsafe-eval`. Inline first-party scripts must
// read the per-request nonce via `headers()` and emit it on the script tag.
// Allowances are explicit and audited:
//   - Clerk hosted UI (script, frame, image, connect).
//   - Sentry (script, connect for the replay endpoint).
//   - Axiom HTTP ingest (connect).

export function buildCsp(nonce: string): string {
  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://*.clerk.accounts.dev https://*.clerk.com https://*.sentry.io`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' data: blob: https://*.clerk.com https://img.clerk.com`,
    `font-src 'self' data:`,
    `connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://*.sentry.io https://*.ingest.sentry.io https://api.axiom.co`,
    `frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
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
