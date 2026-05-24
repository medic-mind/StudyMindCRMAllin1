# ADR 0017: Comprehensive customer view + 90-day historic backfill

- Status: Accepted
- Date: 2026-05-24
- Affects: CLAUDE.md §6.2, §17.1, §37

## Context

The contact detail page rendered a single, generic `Interaction` list
ordered by `occurredAt`. That works for an audit trail but is a poor
"single pane of glass": an agent answering "what is the true status of
this family right now" had to mentally reassemble email threads, group
calls and their transcripts, and spot Slack mentions buried among
hundreds of rows. Each channel has a natural shape — emails are threaded,
calls have recordings and outcomes, Trengo conversations carry a
WhatsApp 24-hour window — and flattening them all into one list loses
that shape.

Separately, when an integration is connected for the first time the
timeline starts empty. A parent who has been emailing and calling for
months shows up as a blank contact until new traffic arrives. We needed
a way to pull recent history on connect so the customer view is useful
from day one.

## Decision

### Comprehensive customer view

Rebuild `apps/web/app/(app)/contacts/[id]/page.tsx` as an aggregated view.
The data model stays polymorphic (`Interaction.type` + JSONB `payload`);
what changes is the read path. Channel-specific **view-models** in
`apps/web/lib/view-models/contact-channels.ts` shape each channel into its
own type (email threads grouped by `payload.gmailThreadId`, calls with
outcome classification and recording keys, Slack mentions, Trengo
conversations grouped by `payload.ticketId` with the 24h reply deadline
derived, tasks split open/closed, notes). They are exposed via a
`contact.channels.*` tRPC namespace and rendered as on-page sections — not
tabs — under a KPI tile strip and a cross-channel search bar. The
aggregate timeline remains as a fallback section.

Three partial indexes on `Interaction` keep these reads cheap on busy
contacts: `(contactId, type, occurredAt DESC)` and expression indexes on
`payload->>'gmailThreadId'` and `payload->>'ticketId'`, all
`WHERE deletedAt IS NULL`.

Call recordings are served by a proxying endpoint
(`/api/internal/audio/[interactionId]`) that verifies Contact read access
via `contact.get`, streams the S3 object, and audits
`interaction.recording_streamed`. We proxy rather than redirect to a
presigned URL so the audit record is honest and access can be throttled
without touching IAM.

### 90-day historic backfill

On first connect (Gmail OAuth callback, Trengo token paste) — and via an
admin "Backfill last 90 days" button for the shared-token providers
(Aircall, Slack) — we insert a `BackfillJob` row and fire a
`backfill/<provider>.requested` Inngest event. One worker per provider
(in `packages/integrations/<svc>/backfill.ts`) pages through 90 days of
history, matches each item to existing Contacts, and writes retroactive
Interactions. Workers are idempotent on the provider's native id and
concurrency-capped per CLAUDE.md §17. Slack reuses the existing
slack-summary AI prompt and only persists matches at confidence ≥ 0.7;
it does **not** create `UnassignedSummary` rows during backfill (too
noisy). A backfill never creates a Contact — unmatched items are skipped.

`startBackfill` lives in `packages/core/backfill`, takes an injected event
sender so `packages/core` stays free of an Inngest dependency, and refuses
a second concurrent job for the same `(provider, agentId)`. Auditing is a
single summary row per job (`backfill.started` / `.completed` / `.failed`
/ `.cancelled`) — never one per imported message.

## Consequences

- The contact page now issues ~8 parallel reads instead of one. The
  partial indexes keep each within budget; if a contact ever grows large
  enough to stress them we can move the channel lists behind Suspense
  boundaries that stream independently.
- Backfill writes can be large. Idempotency + the single-summary-audit
  rule keep re-runs safe and the audit log readable.
- Adding a new channel means adding a view-model + a `contact.channels.*`
  procedure + a section component — the same three-file change as adding a
  webhook handler elsewhere.
