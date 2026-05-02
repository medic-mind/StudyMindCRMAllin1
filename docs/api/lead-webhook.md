# Lead webhook (`POST /api/webhooks/lead`)

Stable, versioned endpoint for partner lead capture (typically via Zapier).
See CLAUDE.md Section 16.

## Auth

Static bearer token in `Authorization: Bearer <LEAD_WEBHOOK_TOKEN>`.
Token rotates quarterly; mirrored from 1Password into Railway env.

## Request schema

```json
{
  "source": "string (e.g. 'zapier:facebook-leadgen')",
  "name": "string?",
  "email": "string? (RFC 5322)",
  "phone": "string? (E.164 preferred)",
  "notes": "string?",
  "raw": { "...": "additive partner-specific fields" }
}
```

Schema is **additive only**. Never remove or rename fields without bumping to
`/api/webhooks/lead/v2`. Old endpoint stays alive for 12 months after a v2 ships.

## Response

- `200` `{ "ok": true }` on accepted lead.
- `401` if the bearer token is missing or wrong.
- `400` if the body fails Zod validation (TODO once the schema is wired).

## Idempotency

The endpoint dedupes on `(source, email | phone)` with a 24h window. Duplicates
return `200` and do not create new rows.
