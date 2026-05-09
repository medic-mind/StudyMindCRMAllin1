# Lead webhook (`POST /api/webhooks/lead`)

Stable, versioned endpoint for partner lead capture (typically via Zapier).
See CLAUDE.md Section 16.

## Auth

Static bearer token in `Authorization: Bearer <token>`.

The handler reads `LEAD_WEBHOOK_BEARER_TOKEN` and falls back to the legacy
`LEAD_WEBHOOK_TOKEN` for compatibility with older Railway environments.
The token comparison is constant-time (`crypto.timingSafeEqual`).

Token rotates quarterly; mirrored from 1Password into Railway env.

## Versions

- `POST /api/webhooks/lead` — v1 (current).
- `POST /api/webhooks/lead/v2` — alias of v1 today, reserved for the next
  schema revision. CLAUDE.md §16 requires the alias to ship before any
  breaking change so partners can migrate without a window of downtime.

When a real v2 ships, the v1 endpoint stays alive for 12 months.

## Request schema (v1)

```json
{
  "source": "zapier:facebook-leadgen",
  "name": "optional human display name",
  "email": "optional RFC 5322 email",
  "phone": "optional E.164 phone",
  "parentName": "optional",
  "studentName": "optional",
  "studentDob": "optional ISO date string",
  "postcode": "optional",
  "ehcp": false,
  "notes": "optional free text up to 10k chars"
}
```

`source` is the only required field. The schema is **additive only** —
never remove or rename. Unknown fields are dropped silently (Zod
`.strict()` is intentionally not used so partner integrations can ride
ahead of the schema).

## Response

- `200 { "ok": true, "id": "<leadId>" }` on accepted lead.
- `200 { "ok": true, "deduped": true, "id": "<existingLeadId>" }` on
  Zapier retry that matches an existing row.
- `400` on invalid JSON or schema validation failure (Zod errors in body).
- `401` if the bearer token is missing or wrong.
- `503` if the bearer token is not configured in env.

## Idempotency

Each request is reduced to a stable key:

```
<source>|<email-lowercased OR phone OR ''>|sha256(notes ?? '').slice(0, 16)
```

If a Lead with that key already exists for the same `source`, the
endpoint returns `200 { ok, deduped: true, id }` without writing.

## Side effects on accept

1. Inserts a `Lead` row.
2. Appends a `lead.received` `Interaction` (orphaned — no Contact yet;
   triage queue picks it up).
3. Writes an `AuditLogEntry` with action `lead.received`.

The Lead is **not** auto-merged into a Contact. Per CLAUDE.md §11 and §35,
"AI suggests, humans confirm". An agent triages from the Leads tray.
