# @studymind/integration-summer-camp

Two-way integration with the **Summer Camp app** (`camp.studymind.co.uk`, repo
`medic-mind/summer-camp-app`). Distinct from `@studymind/integration-booking`,
which mirrors the tutoring platform `booking.studymind.co.uk`.

## Inbound: bookings → CRM (webhook)

The camp app pushes every booking create/update/cancel to
`POST /api/webhooks/summer-camp` as a signed envelope (HMAC-SHA256 of the raw
body, header `x-summer-camp-signature`, secret `SUMMER_CAMP_WEBHOOK_SECRET`).

Flow (CLAUDE.md §7.1): verify → `upsertProviderEvent` (idempotent on
`(provider='summer-camp', eventId)`) → enqueue `summer-camp/event.received` →
200. The Inngest job (`jobs.ts`) loads the event and calls `applyBookingEvent`
(`apply.ts`), which:

- match-or-creates the **guardian** as a `Contact` (kind `parent`) — the
  customer/lead — and the **attendee** as a `Contact` (kind `student`);
- links them with a `parent_of` `ContactLink`;
- writes a `booking` `Interaction` on each timeline (idempotent on
  `payload.externalBookingId`, so updates patch rather than duplicate);
- drops the customer onto the **sales pipeline** (default board's intake stage)
  so the team works it like a lead — deduped to at most one card per contact
  per board, and skipped on cancellations;
- audits the lifecycle event (`summer_camp.booking.*`, deduped on the event id).

Never auto-merges (§3): a single unambiguous email/phone match adopts the
contact (filling blanks only); anything ambiguous creates a fresh one.

## Backfill + periodic sync (pull)

So the CRM holds all *current* bookings (not just ones created after the
webhook was wired) and self-heals any missed webhook, `jobs.ts` adds two pull
jobs over `client.getBookings()` (the camp's keyset `GET /api/external/bookings`):

- **`summer-camp/backfill-bookings`** — one-shot, admin-triggered
  (`summerCamp.backfill`, CEO + Senior Manager; button on `/camps`). Walks every
  booking page-by-page, self-rescheduling on the cursor. Writes one summary
  audit on completion.
- **`summer-camp/sync-bookings`** — cron (every 15 min). Re-pulls bookings
  changed in the last `SUMMER_CAMP_SYNC_LOOKBACK_DAYS` (default 3) and applies
  them. Safety net for missed webhooks; also imports new bookings if the push
  isn't configured.

Both apply via the same `applyBookingEvent` with `audit: false` (the live
webhook is the per-booking audit source) and are fully idempotent, so a re-run
or overlap is safe.

## Outbound: camp feeds → CRM (pull)

`client.ts` reads the camp app's read-only feeds for the CRM's live "Summer
Camps" surface:

- `getCamps(year)` → camps running + subject × week fill grid + per-camp counts;
- `getTimetable(campId?)` → per-camp weekly session timetables;
- `getBookings({ since?, cursor?, limit? })` → keyset booking feed (backfill +
  sync + the bookings workspace). Each booking carries `enrolled_camp_ids`
  (every camp the linked student is enrolled in, primary first) so the CRM
  mirrors multi-camp assignment.

Config is env-only: `SUMMER_CAMP_API_URL` + `SUMMER_CAMP_API_KEY`. Unset → the
client is `null` and the page renders a "not connected" state.

## Write-back: CRM → camp (two-way)

`writeback.ts` — every write goes to the camp app FIRST (it owns bookings; the
CRM never creates one), is audited in the CRM, and converges via the
webhook/pull. Loop-safe: the camp tags CRM writes `system:crm` and does not
echo them; feed notes carry `source:'crm'` so we skip our own round-trip.

- **Contact-level** (hooked best-effort into `contact.update` +
  `interaction.create`): `pushContactDetailsForContact` (identity fields onto
  the contact's latest camp booking), `pushNoteForContact`.
- **Booking-level** (the `/camps/bookings` workspace — the exact booking id is
  known): `pushBookingFields` (status / subject / booking notes via
  `PATCH /api/external/bookings/:id`), `pushCampAssignment` (assign the
  student to camps via `PUT /api/external/bookings/:id/camps` — first id
  becomes the primary camp, all ids mirror into the camp's
  `student_enrolments`), `pushNoteForBooking` (returns the camp's note id, our
  feed-dedupe key).

tRPC surface: `summerCamp.bookings.{list,syncNow,update,assignCamps,addNote}`
+ `summerCamp.purchases.{list,retry,dismiss,scanStripe}` — `bookings.list`
reads the local `CampBookingRecord` mirror (every sync path upserts it via
`apply.ts`, so the workspace survives camp-app downtime); writes are Sales
Executive+ (cancellation Manager+, notes any staff) and each converges the
mirror + fires `summer-camp/sync-bookings.requested`.

## Stripe purchases → camp bookings

The stripe integration's `charge.succeeded` job detects "summer camp" /
"work experience" product text (`detectCampPurchase`, `@studymind/core/camp`)
and fires `summer-camp/purchase.detected`. The worker here records a
`CampStripePurchase` (idempotent on the charge id) and auto-creates the camp
booking via `client.createBooking` (`POST /api/external/bookings`, idempotent
on `payment.reference` = the charge id), then applies the response locally.
Unactionable rows stay `pending` for the `/camps/purchases` tray;
`summer-camp/scan-purchases.requested` (handled in the stripe package) walks
historic charges.

## Env

| Var | Direction | Notes |
|---|---|---|
| `SUMMER_CAMP_WEBHOOK_SECRET` | in | verifies the booking webhook signature |
| `SUMMER_CAMP_API_URL` | out | camp app base URL, e.g. `https://camp.studymind.co.uk` |
| `SUMMER_CAMP_API_KEY` | out | bearer token for the read feeds |

The full cross-app contract lives in the camp repo's `CRM_INTEGRATION.md`.
