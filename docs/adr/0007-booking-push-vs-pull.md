# ADR 0007: Booking site sync — push vs pull

- Status: Proposed (deferred to Phase 2)
- Date: 2026-05-04

## Context

`booking.studymind.co.uk` is the source of truth for booked and delivered hours. The CRM needs to surface bookings and use them as the booking leg of the reconciliation triangle (CLAUDE.md §6.3, §15).

Two possible sync shapes:

- **Pull.** The CRM polls the booking site's REST API on a schedule.
- **Push.** The booking site sends webhooks to the CRM when a booking changes.

We need to decide what ships in Phase 1 and what we move to in Phase 2.

## Decision

**Phase 1: pull only.** The CRM pulls from the booking site:

- Every 5 minutes for active Families.
- Every hour for inactive Families.
- Using `If-Modified-Since` to be polite.

Driven by the `booking/sync-active-families` and `booking/sync-inactive-families` Inngest functions (CLAUDE.md §17.1).

**Phase 2: push, with pull as backstop.** When the booking site team's roadmap allows, they expose webhooks and we add a `/api/webhooks/booking` handler that follows the standard webhook pattern (CLAUDE.md §7.1). Pull continues until push has been stable for 30 days; then pull drops to a daily safety net (and eventually off).

## Why pull first

- **No dependency on the booking site team's roadmap.** Pull is built entirely on our side. Push requires the booking site team to ship signing, retry, ordering, and a handshake — work they have not committed to.
- **Webhooks add complexity we do not need yet.** Signature verification, replay protection, dedupe, ordering — see CLAUDE.md §7 and §8 for the shape of work each provider takes. The booking site is internal to StudyMind but adding it as another webhook source would mean writing the whole pattern over for one more provider.
- **Latency is acceptable.** 5 minutes for active families is well within the 30 second end-to-end SLO that applies to provider-driven flows (CLAUDE.md §25.1) — bookings are not user-blocking in the way a Stripe payment is.

## Why push later

- **Cost.** Polling 5-minutely for hundreds of active families generates load on the booking site even with `If-Modified-Since`. Push is cheaper.
- **Lower latency for delivered hours.** When we move toward real-time reconciliation, push wins.
- **Better shape for cancellations.** Pull misses a booking that is created and cancelled within the polling window; push catches both transitions.

## Migration path when push lands

1. Booking site implements signed webhooks (HMAC SHA-256, `Webhook-Signature` header).
2. CRM adds `/api/webhooks/booking/route.ts` following CLAUDE.md §7.1 — verify, persist `ProviderEvent`, enqueue Inngest, return 2xx.
3. The Inngest job dedupes against the existing pull-driven state. The booking site's REST API stays the source of truth for state; the webhook tells us "something changed", and the job refetches (CLAUDE.md §8 pattern, applied internally).
4. Both sync paths run for 30 days. We monitor that pull catches nothing the push has not already delivered.
5. After 30 days clean, drop active-family pull from 5 minutes to daily, kept as a safety net.
6. After another 30 days, the daily pull either stays as a backstop or is removed via a follow-up ADR.

## Reconciliation rules unchanged

The reconciliation engine in `packages/core/finance/reconcile.ts` does not care how booking data arrives. The booking site is the source of truth for hours regardless of transport (CLAUDE.md §15). Only `delivered` sessions count toward billed hours.

## Consequences

- A 5-minute window where bookings are stale on the CRM. Acceptable for Phase 1.
- A short list of polling failures need their own runbook entry — added under `docs/runbooks/booking-pull-failure.md` when the polling job stabilises.
- We avoid a webhook handler we would otherwise have to maintain forever.

## Alternatives considered

- **Push only.** Rejected — too dependent on the booking site team and too risky for a Phase 1 launch.
- **Push with no pull backstop.** Rejected for migration — webhooks are notifications, not authoritative payloads (CLAUDE.md golden rule 4). A backstop pull during the cutover is cheap insurance.
- **GraphQL subscription.** Rejected — neither system speaks GraphQL today; not worth the new surface for one integration.
