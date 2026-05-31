# Universal lead endpoint (`POST /api/leads`)

Dynamic lead ingestion for Contact Form 7 and any other source. See ADR 0023
and CLAUDE.md §16. The legacy fixed-shape `POST /api/webhooks/lead` (Zapier)
remains documented in `lead-webhook.md`.

## What it does

Accepts a form submission with **any** field names, normalises it (no hardcoded
field ids), persists the raw payload + a `Lead` row, and enqueues async
classification + pipeline routing. Returns within the §25.1 handler budget.

## Auth

A per-website **LeadSource API key** (minted in Settings → Integrations → Lead
webhook; the raw key is shown once, stored hashed). Present it as any of:

- `Authorization: Bearer <key>`
- `X-API-Key: <key>`
- `?key=<key>` query param (for plugins that can only set a URL)

A global fallback token (`LEAD_WEBHOOK_BEARER_TOKEN`) also works and maps to no
source. Missing/invalid key → `401`.

## Body

`application/json`, `application/x-www-form-urlencoded`, or `multipart/form-data`.
Field roles are detected automatically:

| Signal (in priority order) | Example                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `webhook:<role>` mapping   | `webhook:name`, `webhook:email`, `webhook:phone`                   |
| name synonym               | `your-email`, `phone-number`, `first-name`, `your-message`         |
| CF7 type prefix            | `tel-146` → phone, `email-9` → email, `textarea-3` → message       |
| value sniffing             | a value matching an email/phone regex; longest free text → message |

Landing-page intelligence is lifted from hidden fields (`page-url`, `_wpcf7`),
`?url=`/`?form_title=`/`?source=` query params, or the `Origin`/`Referer`
headers, plus any `utm_*` fields or URL params.

### Example (Contact Form 7, form-encoded)

```
POST /api/leads?key=sk_lead_xxx
Content-Type: application/x-www-form-urlencoded

your-name=Jane+Smith&tel-146=07700+900123&email=jane%40example.com
&your-message=UCAT+help+please&page-url=https://medicmind.co.uk/ucat-course/
```

## Response

- `200 { "ok": true, "id": "<leadId>", "status": "received" }` — accepted.
- `200 { "ok": true, "deduped": true }` — identical double-fire within 5 min.
- `400` — unparseable or empty body.
- `401` — missing/invalid key.

## After acceptance (async)

The `lead/classify.requested` job classifies the lead (brand → `Company`,
products/categories from configurable rules + the catalogue, score, optional AI
summary) and routes it:

- **first enquiry** → new Contact (brand-tagged) + a card on the default board's
  "New leads" stage;
- **re-enquiry** (matched by email/phone) → annotate the existing contact; add a
  fresh card only if >24h since the last enquiry (anti-spam);
- **no email/phone or ambiguous match** → the Leads tray (`/leads`) as
  `needs_triage`.

Nothing is auto-merged (CLAUDE.md §41.1). Everything is audited
(`lead.received` → `lead.converted` / `lead.reenquiry_recorded` /
`lead.classified`).

## Configuration (no developer needed)

- **Brand detection** — `BrandDomainRule` (domain → Company), seeded for the
  five brands.
- **URL/product intelligence** — `UrlClassificationRule` (slug/URL/title →
  product tags + categories) and the `ProductCatalogueItem` master catalogue,
  both seeded and DB-editable.
- **API keys** — `LeadSource`, managed from the Integrations panel.
