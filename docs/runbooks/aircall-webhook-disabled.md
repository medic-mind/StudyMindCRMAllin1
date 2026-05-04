# Runbook: Aircall webhook disabled

Aircall disables a webhook endpoint after 10 consecutive failures (4xx or 5xx, or no 2xx within the timeout). When that happens we stop receiving call events entirely until the webhook is re-enabled. See CLAUDE.md §10 and §17.1 for context.

## Detection

Two signals fire:

- **Axiom alert** `aircall.webhook.failure_rate` — triggers when the 5-minute failure rate per webhook exceeds 20 percent. The alert links here.
- **On-call dashboard** — the "Aircall webhook health" tile turns red when no `call.created` event has landed for the rolling 30-minute window during business hours.

The recurring `aircall/recover-disabled-webhook` Inngest job (CLAUDE.md §17.1) also detects and attempts re-enable hourly. If that job has succeeded silently you may see the alert clear on its own — confirm before standing down.

## Confirm the webhook is disabled

```bash
curl -s -H "Authorization: Basic $AIRCALL_API_TOKEN" \
  https://api.aircall.io/v1/webhooks | jq '.webhooks[] | {webhook_id, url, active, events}'
```

Look for `active: false` on the production webhook (URL ends `/api/webhooks/aircall`). If `active: true`, the alert is a false positive — investigate Axiom for receive-side errors instead.

## Re-enable

```bash
curl -s -X PUT -H "Authorization: Basic $AIRCALL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active": true}' \
  https://api.aircall.io/v1/webhooks/$WEBHOOK_ID
```

The `aircall/recover-disabled-webhook` job runs the same call. Triggering manually is fine if you want immediate recovery; the job is idempotent.

After re-enabling, confirm the next inbound `call.created` lands as a `ProviderEvent` row:

```sql
select id, type, received_at from "ProviderEvent"
where provider = 'aircall' order by received_at desc limit 5;
```

## Backfill the gap

Aircall does **not** replay missed webhook events. We must pull them via REST.

1. Determine the gap window: last successful `ProviderEvent.receivedAt` for `provider='aircall'` to now.
2. Run `pnpm tsx scripts/aircall-backfill.ts --from <ISO> --to <ISO>`. This pages through `GET /v1/calls?from=...&to=...`, normalises each into the same shape the webhook would have produced, and enqueues `aircall/event.received` Inngest events with `source: 'backfill'` set on the payload.
3. The downstream job is idempotent on `(provider, eventId)` so any calls that did make it through the webhook before the disable will dedupe automatically.
4. Spot-check a handful of calls in the timeline view for affected Families.

Voicemail recordings and transcripts pulled during backfill follow the standard recording flow (S3 push, Whisper if AI Assist absent — see CLAUDE.md §10).

## Postmortem trigger

Open a Sev 2 postmortem if any of:

- Gap exceeded 30 minutes during business hours.
- A safeguarding-relevant call was missed (caller flagged `restricted_access`).
- The webhook has been disabled twice within 30 days — this points at a deeper receive-side bug, not Aircall flakiness.

Otherwise, log a Sev 3 ticket with the gap window and root cause, and update this runbook if the procedure changed.
