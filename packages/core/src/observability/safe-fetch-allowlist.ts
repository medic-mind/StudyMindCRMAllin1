// SSRF allowlist. CLAUDE.md §44.2.
//
// Outbound HTTP from the worker (and any code path on the server) MUST go
// through safeFetch, which checks the host of the URL against this list.
// Adding a host is a code change reviewed in PR.
//
// Wildcards: a leading "*." matches any subdomain depth. We do not pattern
// match on path or scheme; any non-https URL is rejected by safeFetch.

export const SAFE_FETCH_ALLOWLIST: readonly string[] = [
  // Stripe
  'api.stripe.com',
  'files.stripe.com',
  // GoCardless
  'api.gocardless.com',
  'api-sandbox.gocardless.com',
  // Aircall
  'api.aircall.io',
  'public-api.aircall.io',
  '*.aircall.io',
  // Trengo
  'app.trengo.com',
  '*.trengo.com',
  // Slack
  'slack.com',
  '*.slack.com',
  'hooks.slack.com',
  // Asana
  'app.asana.com',
  '*.asana.com',
  // Google APIs (Gmail, Pub/Sub, OAuth, Cloud Storage)
  'oauth2.googleapis.com',
  'gmail.googleapis.com',
  'pubsub.googleapis.com',
  'www.googleapis.com',
  'storage.googleapis.com',
  // OpenAI
  'api.openai.com',
  // AWS endpoints (KMS, S3 in eu-west-2)
  '*.amazonaws.com',
  // CloudFront — Aircall serves call-recording media from its CDN; the URL
  // comes from Aircall's trusted API response (never user input).
  '*.cloudfront.net',
  // Booking site
  'booking.studymind.co.uk',
  // B2B Invoices Platform (CRM ↔ invoicing two-way sync)
  'b2b.studymind.co.uk',
  // Axiom (log ingest)
  'api.axiom.co',
  // Sentry ingest
  '*.ingest.sentry.io',
  '*.sentry.io',
  // PagerDuty (Events API v2)
  'events.pagerduty.com',
  // Zoom (Server-to-Server OAuth + REST API) — webinar link generation +
  // recordings (ADR 0035).
  'zoom.us',
  'api.zoom.us',
  '*.zoom.us',
]

/** True if `host` is exactly listed or matches a `*.suffix` wildcard entry. */
export function isAllowedHost(host: string): boolean {
  const lower = host.toLowerCase()
  for (const entry of SAFE_FETCH_ALLOWLIST) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // ".aircall.io"
      if (lower === entry.slice(2) || lower.endsWith(suffix)) return true
    } else if (lower === entry) {
      return true
    }
  }
  return false
}
