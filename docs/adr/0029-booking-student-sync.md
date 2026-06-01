# ADR 0029: Booking-site sync is student-centric, incremental, and pull-based

- Status: Accepted
- Date: 2026-05-31
- Supersedes the data-model assumptions of the Phase-1 booking scaffold; the
  transport decision in ADR 0007 (pull-first, push later) is unchanged.

## Context

`booking.studymind.co.uk` is the source of truth for students, lessons, the
hours-balance ledger and credits (CLAUDE.md §15). The original booking
integration scaffold (`packages/integrations/booking/`) was written against an
**assumed** `families → bookings → sessions` REST shape. The real booking admin
is **student-centric**: a _student_ (with an optional guardian/bill-payer, an
hours balance with expiry, and MMI/Live-Day _credits_), _lessons_ (tutor,
subject, start/end, status, payment, trial feedback), and two ledgers (balance
history, credit history). This also matches the May-2026 product direction —
contacts are students or parents/guardians linked by contact relations, not
grouped into a Family (CLAUDE.md "Per-contact engagement metrics").

The booking API does not exist yet; the contract we need from it is specified in
`docs/api/booking-pull-api.md`. We want the CRM side fully built and safe to
merge **before** that API ships, so the only remaining work is the booking
team's, and flipping it on is a config change.

## Decision

**1. Student-centric mirror.** A booking student maps to a `Contact`
(`kind = student`) keyed on `Contact.bookingContactId = <booking uuid>`. The
richer booking data hangs off that Contact so the hot row stays lean:

- `ContactBookingProfile` (1:1) — guardian/bill-payer, the hours-balance summary
  (incl. premium hours + next expiry) and current credit balances.
- `BookingLesson` — one row per lesson, the queryable state layer; the body also
  lands as a `booking` Interaction for the timeline (same split as Conversation
  vs Interaction, ADR 0020).
- `BookingHoursTransaction` — the hours ledger (signed hours, expiry, Stripe ref).
- `BookingCreditTransaction` — the credit ledger (MMI / Live Day).
- `BookingSyncCursor` — per-resource incremental high-water mark + page cursor.

These coexist with the legacy family-centric `Booking`/`BookingSession`, which
the reconciliation engine still reads (CLAUDE.md §19 forward-only). Wiring
lessons into reconciliation is a documented follow-up, kept out of this change so
finance stays stable.

**2. Incremental, global, keyset pull.** Each resource is pulled with its own
cursor: "what changed since X?", keyset-paginated, bounded per cron tick
(`MAX_PAGES_PER_RUN`). The first run (no high-water mark) backfills by walking the
cursor across ticks. Four crons: `booking/sync-students` and
`booking/sync-lessons` every 5 min; `booking/sync-balance-ledger` and
`booking/sync-credit-ledger` every 15 min. This replaces the per-family fan-out
of the old scaffold (one request per family per poll), which was exactly the load
pattern that would have slowed the booking site.

**3. Safe before the API exists.** The jobs no-op when `BOOKING_API_TOKEN` is
unset (they log and return rather than throwing every tick). All wire types are
mapped at the boundary; the one closed enum (credit kind) fails closed, while
lesson status/payment and ledger `type` are stored as normalised text until the
booking team confirms the value sets (`docs/api/booking-pull-api.md` §2.3) so a
new value never blocks a sync.

**4. No silent merges, no clobbering.** Contact matching is exact on
`bookingContactId`, else a single unambiguous email/phone match (adopted), else a
new Contact — we never merge two CRM contacts (CLAUDE.md §3). On an adopted
contact we fill identity fields only when empty and always refresh
booking-derived metrics. One summary audit row per sync run, never per imported
row (CLAUDE.md §17.1).

## Consequences

- The CRM can mirror the full booking dataset the moment the API is live; until
  then the surface is dormant and harmless.
- Credits are now a first-class CRM concept (new tables + the `BookingCreditKind`
  enum).
- Hours are stored at 2dp (`Decimal`) in the new ledger; the existing
  `Contact.hoursBooked`/`hoursDelivered` integer summary columns are kept current
  (rounded) for the Contacts list.
- `BusinessAccountStudent.syncFromBooking` is wired to the same client (per-student
  fetch) and returns a clear `synced | skipped` status.
- Follow-ups: promote guardians to linked Contacts; recompute precise per-lesson
  delivered hours + spend; feed lessons into reconciliation; a Contact-page panel
  for the hours/credit ledgers; Phase-2 webhooks (ADR 0007) once the API is stable.

## Alternatives considered

- **Keep the family/booking/session shape.** Rejected — it doesn't match the
  booking site or the product direction, and would force the booking team to
  invent a "family" concept they don't have.
- **Per-student endpoints in the poll loop.** Rejected — N requests per poll is
  the load pattern we're explicitly avoiding. Global incremental list endpoints
  keep each poll to a handful of requests (`docs/api/booking-pull-api.md` §4).
- **Postgres enums for lesson status/payment now.** Deferred — the value sets are
  unconfirmed; append-only enum migrations before the contract firms up would be
  churn. Normalised text + a documented known-set is the flexible choice.
