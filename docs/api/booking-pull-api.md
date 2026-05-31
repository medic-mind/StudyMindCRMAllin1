# Booking site → CRM pull API (the contract we need from `booking.studymind.co.uk`)

> **Purpose.** The CRM needs to mirror every student, lesson, hours-balance
> movement and credit movement from `booking.studymind.co.uk` so staff can see a
> family's true status without opening the booking admin. The booking site stays
> the **source of truth** for hours and lessons (CLAUDE.md §15); the CRM is a
> read-only mirror that **pulls** on a schedule (ADR 0007). This document is the
> contract the booking-site developer needs to implement. Nothing here writes
> back to the booking site.
>
> **Guiding principle (so we never slow the site down):** read-only, incremental,
> cheap. The CRM should be able to stay in sync by making a *handful* of requests
> per poll regardless of how many students exist — never one request per student.

---

## 0. The one decision that shapes everything: student-centric, not family-centric

The booking site is organised around **students** (each with an optional
guardian / bill-payer), **lessons**, an **hours balance ledger**, and **credits**
(Online MMI, In-Person MMI, Live Day, In-Person Live Day). It has no concept of a
"family". Please build the API around those four resources exactly as they exist
today. The CRM will map a student → a Contact, a guardian → a linked Contact, and
derive everything else on our side. **Do not invent new groupings for us.**

---

## 1. Auth & transport

- **Base URL:** `https://booking.studymind.co.uk/api/v1`
- **Auth:** a single read-only service token, sent as `Authorization: Bearer <token>`.
  - Issue us one token for the CRM. Scope it **read-only** — these endpoints must
    never mutate booking data.
  - Let us rotate it without redeploying you (env var on your side).
  - Optional but welcome: allow-list the CRM's egress IP(s).
- **HTTPS only.** Reject plain HTTP.
- **Responses:** JSON, `Content-Type: application/json; charset=utf-8`.
- **No PII in URLs** beyond the student UUID (already opaque). No emails/phones in
  query strings.

---

## 2. Conventions (apply to every endpoint)

### 2.1 Identifiers
- **Student key = the UUID** (e.g. `2d613f6b-692c-48a5-bc58-680befeafc50`), not the
  integer `id`. The UUID is stable and non-guessable; that's what the CRM stores
  as its cross-reference. Please include **both** `uuid` and the legacy integer
  `id` (we'll show the integer to staff because that's what they recognise).
- **Lesson key = the integer lesson id** (e.g. `203437`) — stable, fine as-is.
- **Ledger rows** (balance + credit movements) each need their own stable `id`.

### 2.2 Timestamps, money, hours
- **Timestamps:** ISO 8601 in **UTC** with a `Z` suffix, e.g.
  `2020-11-13T00:27:38Z`. Never send local time without an offset.
- **Money:** integer **pence** in a field suffixed `_pence` (e.g.
  `amount_pence: 4500` = £45.00). Never floats, never `"£45.00"` strings.
- **Hours:** a JSON number with at most 2 decimal places, e.g. `1.5`, `5`, `0.25`.
  (The admin shows `5.00 hours`; a 30-minute session is `0.5`.) Hours can be
  **signed** in the ledger: positive = added, negative = used/deducted.

### 2.3 Enums = stable lowercase strings
Send enums as lowercase snake_case strings, and **don't rename them** once shipped
(add new values instead). We fail closed on unknown values (CLAUDE.md §8), so a
silent rename breaks sync. Please give us the **complete list of possible values**
for: lesson `status`, lesson `payment`, balance-transaction `type`, credit `type`,
and `credit_kind`. The values we can already see in the admin:
- lesson `status`: `active`, `cancelled` (… any others?)
- lesson `payment`: `charged`, `no_fee` (… any others?)
- `trial_feedback_status`: `pending` (… `submitted`? `not_required`?)

### 2.4 Pagination — keyset, never OFFSET
Every list endpoint is cursor-paginated on `(updated_at, id)`:

```
GET /api/v1/students?updated_since=2026-05-01T00:00:00Z&limit=200
→ 200 OK
{
  "data": [ … ],
  "next_cursor": "eyJ1cGRhdGVkX2F0IjoiMjAyNi0wNS0wMVQwMDowMDowMFoiLCJpZCI6MTIzfQ==",
  "has_more": true
}
```

- `limit`: default **100**, max **500**.
- `next_cursor`: opaque string; we send it back as `?cursor=<next_cursor>` to get
  the next page. Keyset, **not** `OFFSET` — OFFSET pagination degrades badly on
  large tables and is exactly the kind of query that slows a site down.
- `has_more: false` (or a null `next_cursor`) means we've drained the page set.

### 2.5 Incremental sync — `updated_since`
- Every list endpoint accepts `?updated_since=<ISO8601>` and returns **only rows
  whose `updated_at` ≥ that timestamp**, ordered by `(updated_at, id)` ascending.
- This is the heart of "don't slow the site down": our 5-minute poll asks
  "what changed in the last 5 minutes?" and you answer from an index on
  `updated_at`, not a full-table scan.
- Omitting `updated_since` returns everything from the beginning — that's our
  **initial backfill** path (walk the cursor to completion once, then switch to
  incremental).

### 2.6 Deletions & cancellations need to be *visible* (tombstones)
A pull-based mirror can't see a row that simply vanishes. So:
- **Never hard-delete** a row we've seen; soft-delete it and expose `deleted_at`
  (null when live). Bump `updated_at` when you soft-delete so the incremental poll
  picks it up.
- Cancelling a lesson is a `status: "cancelled"` change (not a delete) — we keep
  the row and reflect the status. Same for voided balance rows (`type: "voided"`).

### 2.7 Cheap polls — `If-Modified-Since` / ETag
- Honour `If-Modified-Since` (and/or return an `ETag` we can send back as
  `If-None-Match`). When nothing changed since our last poll, **return `304 Not
  Modified` with an empty body.** Most of our 5-minute polls should be a 304.

### 2.8 Errors & rate limits
- Standard HTTP codes: `400` bad params, `401` bad/missing token, `404` unknown
  resource, `429` rate-limited, `5xx` your error.
- On `429`, send a `Retry-After` header (seconds). We back off and retry — we will
  never hammer you.
- Error body: `{ "error": { "code": "…", "message": "…" } }`.

---

## 3. Endpoints

> The four list endpoints below are **global and incremental** — that's the
> design that keeps load flat. We will **not** call a per-student endpoint in a
> loop on every poll.

### 3.1 `GET /api/v1/students` — students (list, incremental)
One row per student. Fields (✱ = required to unblock us; rest are welcome):

| field | type | notes / source in admin |
|---|---|---|
| `uuid` ✱ | string | the stable key (Student Details → UUID) |
| `id` ✱ | integer | legacy integer id staff recognise (e.g. `5`) |
| `first_name` / `last_name` | string\|null | if you only store "Full Name", send `full_name` and we'll split |
| `full_name` ✱ | string | as shown in the Students table |
| `email` ✱ | string\|null | Student Details → Email |
| `phone` ✱ | string\|null | **E.164** (`+447749928000`) |
| `date_of_birth` | date (`YYYY-MM-DD`)\|null | Student Details → DOB |
| `country` | string\|null | Student Details → International (e.g. `UK`) |
| `receive_marketing_emails` | boolean | "Receive emails from Study Mind" |
| `added_by_agent` | boolean | Student Details → Added by Agent |
| `has_guardian` ✱ | boolean | "Do you have a guardian or bill payer?" |
| `guardian_name` | string\|null | Students table → Guardian Name |
| `guardian_phone` | string\|null | E.164; Students table → Guardian Phone |
| `guardian_email` | string\|null | if held |
| `labels` | string[] | Students table → Labels |
| `balance` ✱ | object | the hours summary, see below |
| `credits` | object | current credit balances, see below |
| `registered_at` ✱ | datetime | Student Details → Registered At |
| `created_at` ✱ | datetime | |
| `updated_at` ✱ | datetime | **drives incremental sync — must bump on any change, incl. balance/credit/guardian edits** |
| `deleted_at` | datetime\|null | tombstone |

`balance` object (from the Balance Summary panel — send the **current totals**, we
keep our own running history from §3.3):

```jsonc
"balance": {
  "hours_added": 46,
  "hours_used": 17,
  "hours_deducted": 29,
  "hours_remaining": 0,            // the headline figure
  "premium_hours_added": 0,
  "premium_hours_used": 0,
  "premium_hours_deducted": 0,
  "premium_hours_remaining": 0,
  "next_expiry_at": "2022-02-13T01:09:00Z"  // earliest unexpired bucket, or null
}
```

`credits` object (from the Adjust Credits modal — **current** balance per kind):

```jsonc
"credits": {
  "online_mmi": 0,
  "in_person_mmi": 0,
  "live_day": 0,
  "in_person_live_day": 0
}
```

### 3.2 `GET /api/v1/lessons` — lessons (list, incremental)
One row per lesson (the `/admin/lessons/` table). Fields:

| field | type | notes |
|---|---|---|
| `id` ✱ | integer | lesson id (`203437`) |
| `student_uuid` ✱ | string | FK to the student |
| `tutor_id` | integer\|null | null if tutor deleted |
| `tutor_name` ✱ | string | `"[Deleted Tutor]"` is fine when deleted |
| `subject` ✱ | string | lowercase: `ucat`, `lnat`, `bmat`, `11+`, `gamsat`, `hpat`… |
| `starts_at` ✱ | datetime | lesson start (UTC) |
| `ends_at` ✱ | datetime | lesson end (UTC) |
| `duration_hours` | number | if you don't store it we derive from start/end |
| `status` ✱ | enum string | `active`, `cancelled`, … (full list please) |
| `payment` ✱ | enum string | `charged`, `no_fee`, … (full list please) |
| `is_trial` | boolean | |
| `trial_feedback` | string\|null | free text |
| `trial_feedback_status` | enum string\|null | `pending`, … |
| `created_at` ✱ | datetime | |
| `updated_at` ✱ | datetime | drives incremental sync |
| `deleted_at` | datetime\|null | tombstone |

### 3.3 `GET /api/v1/balance-transactions` — the hours ledger (list, incremental)
One row per Balance History line (the table in the Balance History modal). This is
how we reconstruct hours over time and reconcile against Stripe/GoCardless.

| field | type | notes |
|---|---|---|
| `id` ✱ | string/int | stable row id |
| `student_uuid` ✱ | string | |
| `hours` ✱ | number (signed) | `+5`, `-5`, `+20`, `-1`… (added vs used/deducted) |
| `is_premium` | boolean | premium-hours bucket vs normal |
| `amount_pence` | integer\|null | "Amount" column when present |
| `stripe_reference` | string\|null | "Stripe Reference" column |
| `message` | string\|null | "Message" column (`"Automated - Essay Submission"`, `"Voided"`, …) |
| `type` ✱ | enum string | e.g. `purchase`, `manual_add`, `usage`, `deduction`, `voided`, `automated_essay` — please send the real set |
| `admin_id` | integer\|null | null = system/automated |
| `admin_name` | string\|null | "Admin Name" column |
| `occurred_at` ✱ | datetime | "Timestamp" column |
| `expires_at` | datetime\|null | "Expiry" column — hours expire, we need this |
| `created_at` ✱ | datetime | |
| `updated_at` ✱ | datetime | drives incremental sync |
| `deleted_at` | datetime\|null | |

### 3.4 `GET /api/v1/credit-transactions` — the credits ledger (list, incremental)
One row per Credit History line (the table under the Adjust Credits modal).

| field | type | notes |
|---|---|---|
| `id` ✱ | string/int | stable row id |
| `student_uuid` ✱ | string | |
| `credit_kind` ✱ | enum string | `online_mmi` \| `in_person_mmi` \| `live_day` \| `in_person_live_day` |
| `credits` ✱ | integer (signed) | "Credits" column |
| `stripe_reference` | string\|null | |
| `message` | string\|null | |
| `type` ✱ | enum string | "Type" column — please send the real set |
| `admin_id` | integer\|null | |
| `admin_name` | string\|null | |
| `occurred_at` ✱ | datetime | "Timestamp" column |
| `created_at` ✱ | datetime | |
| `updated_at` ✱ | datetime | drives incremental sync |
| `deleted_at` | datetime\|null | |

### 3.5 (Optional) `GET /api/v1/students/{uuid}` — single-student detail
Same shape as a `students` row. We only call this on demand (an agent opening a
profile, or to recover a single record) — never in a poll loop. Nice to have, not
required for v1.

---

## 4. Performance requirements (the "don't slow the site down" checklist)

These are the asks that protect the booking site under our polling. Please:

1. **Serve reads off a replica / cache, not the primary write path** if you have a
   read replica. Slightly stale (seconds–minutes) is fine — we poll, we're not
   real-time.
2. **Index `updated_at` (and `(updated_at, id)`)** on students, lessons, and both
   ledgers. The incremental query must hit an index, never a full scan.
3. **Keyset pagination only** (§2.4). No `OFFSET`/`LIMIT` deep paging.
4. **Bounded page size** — cap at 500 so one request can't pull the whole table.
5. **`304 Not Modified`** when nothing changed (§2.7) — most polls cost you almost
   nothing.
6. **Rate-limit us and tell us** via `429` + `Retry-After`. We'll respect it.
7. **Initial backfill is a one-off** — we'll walk the full cursor once, off-peak if
   you prefer (tell us a quiet window), then switch to 5-minute incremental polls
   that only ever return recent changes.

Our polling cadence (your side just needs to answer cheaply):
- Active students: every **5 minutes**, incremental.
- Everyone else: **hourly**, incremental.

---

## 5. Phase 2 (later, optional): push instead of poll

Once the pull API is stable, we can drop polling frequency dramatically if you
later add **webhooks**: POST a small signed event to
`https://crm.studymind.co.uk/api/webhooks/booking` whenever a student/lesson/ledger
row changes — `{ "type": "lesson.updated", "id": 203437 }` is enough; we refetch
the canonical row from the API above. This is **not** required now (ADR 0007: pull
first). If/when you want it: HMAC-SHA256 the raw body with a shared secret in a
`Webhook-Signature` header, and we'll keep the pull running as a backstop for 30
days during cutover.

---

## 6. What "done enough to start" looks like

If you want to ship in slices, this order unblocks the CRM fastest:

1. **`GET /api/v1/students`** (incremental + cursor) with the ✱ fields + `balance`.
   → CRM can mirror students, show hours remaining, and split leads from
   registered students.
2. **`GET /api/v1/lessons`** (incremental + cursor).
   → CRM timeline shows lessons; we derive hours delivered + last-lesson date.
3. **`GET /api/v1/balance-transactions`** and **`GET /api/v1/credit-transactions`**.
   → Full hours/credits ledger + finance reconciliation.

Everything else (single-student detail, webhooks) is additive.

---

## 7. CRM-side notes (for our team, not the booking developer)

- The existing scaffold in `packages/integrations/booking/` assumes a
  **family/booking/session** shape (`/api/v1/families/...`) — it predates the
  student-centric product direction (CLAUDE.md "Per-contact engagement metrics"
  note, May 2026). When this API lands we rework the client + jobs to the
  student/lesson/ledger shape above and map:
  - student → `Contact` (`kind = student`), keyed on `Contact.bookingContactId = uuid`;
    set `bookingStatus`, `hoursBooked`, `hoursDelivered`, `lastLessonAt`,
    `amountSpentMinor`, `bookingLastSyncAt`.
  - guardian → `Contact` (`kind = parent/guardian`) + `ContactLink` (`guardian_of`).
  - lesson → `booking` `Interaction` on the student contact (+ feed
    `Booking`/`BookingSession` for reconciliation).
  - balance/credit ledgers → new tables (hours + credits have **expiry** and a
    `_pence`/Stripe ref the current `Booking` model doesn't carry).
  - `BusinessAccountStudent.bookingStudentId` / `syncFromBooking` gets wired to the
    same client.
- Credits (MMI / Live Day) are a **new product concept** in the CRM — they need
  schema (ADR + migration) before we can store them.
- Env already reserved: `BOOKING_API_BASE_URL`, `BOOKING_API_TOKEN`
  (`.env.example`). Note the base URL there is `…/api`; the contract above is
  `…/api/v1` — we'll align when we wire it up.
