# CLAUDE.md — StudyMind All in One CRM

> Source of truth for Claude Code working on the StudyMind All in One CRM. Read fully before changes. Fix this doc in the same PR as the code.

---

## 1. What we are building

**Product:** StudyMind All in One CRM
**One line:** A single pane of glass for everything StudyMind does — every email, call, message, payment, booking, task, and AI insight about every parent, student, tutor, and Local Authority contact, in one place.

**Why:** Today the team juggles Gmail, Aircall, Slack, Trengo, Asana, Stripe, GoCardless, the booking site, and Zapier glue. Information is scattered, double entry is constant, nobody can answer "what is the true status of this family right now" in under two minutes.

**Users (staff only):**
- Operations agents — day to day comms, scheduling, follow ups
- Finance lead — payments, reconciliation, dunning, refunds
- Account owners and senior team — pipeline, retention, AP tender work
- Designated Safeguarding Lead (DSL) — safeguarding flags, restricted notes

Parents, students, tutors do **not** log in. They use the booking site, Trengo, email, phone.

---

## 2. Golden rules (read every time)

1. **GDPR and child safety are non negotiable.** We process data on minors, EHCPs, and SEND placements. Every change considers audit, retention, encryption, and access control before it ships.
2. **Idempotency or it didn't happen.** Every webhook handler, background job, and external API call is idempotent. We will receive duplicate events from Stripe, GoCardless, Aircall, Asana, Gmail, Trengo. Dedupe on provider event ID.
3. **No silent data mutation.** Never auto merge contacts, never auto delete, never auto charge. AI suggests, humans confirm.
4. **External APIs are the source of truth, not our DB.** When in doubt, refetch from Stripe or GoCardless. Webhooks are notifications, not authoritative payloads.
5. **Every write is audited.** If a row touches a Contact, FinancialAccount, or anything safeguarding related, it goes into AuditLogEntry. No exceptions.
6. **The booking site is read mostly.** We sync from booking.studymind.co.uk and surface its data. Writes back are scoped, explicit, and logged.
7. **Background jobs do the work, request handlers stay thin.** API routes verify the signature, persist the raw payload, enqueue an Inngest job, return 200. Nothing else.
8. **Style.** Small functions, descriptive names, no clever tricks. Optimise for the next engineer reading this in six months.

---

## 3. Tech stack (locked decisions)

| Layer | Choice | Rationale |
|---|---|---|
| Framework | Next.js 15 App Router, TypeScript strict | Single deployable, RSC for fast contact lists, mature on Railway |
| UI | Tailwind CSS + shadcn/ui + Radix primitives | Fast to build, accessible by default, easy to theme |
| Forms | React Hook Form + Zod | Schema first, end to end typesafe |
| DB | PostgreSQL on Railway | Plan for read replica from month 6 |
| ORM | Prisma | Migrations, typesafe queries, broad team familiarity |
| Background jobs | Inngest (chosen over Trigger.dev) | Better fan out, native step retries, cleaner local dev |
| Auth | Clerk | SSO, MFA, RBAC, audit hooks out of the box |
| File and audio storage | AWS S3 (eu-west-2) | Call recordings, email attachments, DSAR exports |
| Encryption (field level) | AWS KMS envelope encryption | Safeguarding notes, EHCP extracts |
| Email transactional | Resend | Outbound system email, not Gmail sync |
| Observability | Sentry (errors), Axiom (logs), OpenTelemetry traces | Required from day one |
| AI | OpenAI gpt-4o, gpt-4o-mini, Whisper | Mini for cheap classification, 4o for drafting |
| Hosting | Railway (services: web, worker, postgres, redis) | Single platform for the whole stack |
| Cache and rate limit | Redis on Railway (Upstash compatible) | Inngest queue, rate limit windows, response cache |

**No new dependencies without an ADR.** See `docs/adr/`.

> **Hosting note.** Frontend and backend live in this Next.js app on Railway. We do not use Supabase, Firebase, or any BaaS. Postgres is owned by us on Railway; row level security is enforced at the application layer through tRPC procedures and `packages/core/auth/policies.ts`, not in the database.

---

## 4. Brand and product identity

The CRM is internal but it is the daily workspace for the people speaking to families on our behalf. The interface should feel like StudyMind — calm, careful, expert — so that tone carries into every email, call, and Trengo message agents send from inside it.

**Voice.** Warm, professional, and specific. We write to parents and Local Authorities with care. We avoid jargon when speaking to families and use precise statutory language (EHCP, Section 19, AP) when speaking to Local Authorities. Never patronising, never breezy about safeguarding.

**Naming.** "StudyMind" is one word, capitalised S and M. Never "Study Mind" or "Studymind" in product copy. The CRM internal product name is "StudyMind All in One CRM"; in UI chrome we shorten to "StudyMind CRM".

**Design tokens.** All colour, typography, spacing, and radius values live in `packages/ui/tokens/` as the single source of truth. Tailwind reads from those tokens — never hard code a hex value in a component. If a designer sends a new colour, it lands in tokens first, then components reference it.

**Palette intent.** Primary blue communicates trust and clinical calm. A warm secondary (used sparingly) marks safeguarding and finance affordances that need attention without alarm. Status colours map: success green, warning amber, danger red, info blue. No new status colours without a token.

**Typography.** One sans family for product UI (set in tokens), one mono family for code, IDs, and amounts. Numerals are tabular wherever they line up vertically (finance tables, reconciliation, ledgers). Headings use a tighter tracking; body uses default tracking and 1.5 line height for readability of long timelines.

**Density.** The CRM is dense by design — agents work fast and need to see a lot at once. Default to compact rows in lists, with a comfortable density toggle in user settings. Do not pad for prettiness; pad for legibility.

**Iconography.** Lucide icons via shadcn. No emoji in the product UI, ever. No custom one-off SVGs without designer review.

**Empty states.** Never "No data". Always say what should be here, and what action would create it. Example: "No interactions yet — start by sending a message or logging a call." Empty states for finance tables include the reconciliation status of the parent Family.

**Error states.** Plain English, owned by us. Say what failed, what we will do about it, and what the agent can do now. Include a request id for support. Never expose stack traces or provider error codes in user-facing copy — those go to Sentry.

**Tone of AI output.** AI-drafted replies inside the CRM are clearly labelled as drafts. The agent must edit and confirm before sending. Drafts default to StudyMind house style: warm opener, specific to the family, action-oriented closer. Templates live in `packages/ai/prompts/style/` and are versioned.

---

## 5. Repository layout

```
/
├── apps/
│   └── web/                    # Next.js app — the only deployable web service
│       ├── app/                # App Router pages and layouts
│       │   ├── (auth)/         # Clerk sign in pages
│       │   ├── (app)/          # Authenticated CRM shell
│       │   │   ├── inbox/
│       │   │   ├── contacts/
│       │   │   ├── pipeline/
│       │   │   ├── tasks/
│       │   │   ├── finance/
│       │   │   ├── reports/
│       │   │   └── settings/
│       │   └── api/
│       │       ├── webhooks/   # All inbound webhooks live here
│       │       │   ├── stripe/
│       │       │   ├── gocardless/
│       │       │   ├── aircall/
│       │       │   ├── trengo/
│       │       │   ├── slack/
│       │       │   ├── asana/
│       │       │   ├── gmail/
│       │       │   ├── booking/
│       │       │   └── lead/
│       │       └── trpc/       # Internal RPC for the UI
│       ├── components/
│       │   ├── ui/             # shadcn primitives (do not modify, regenerate)
│       │   ├── contact/
│       │   ├── timeline/
│       │   ├── finance/
│       │   └── shared/
│       └── lib/
├── packages/
│   ├── db/                     # Prisma schema, migrations, seed
│   ├── core/                   # Domain logic (pure, no I/O)
│   │   ├── contact/
│   │   ├── family/             # Parent + student grouping
│   │   ├── finance/            # Reconciliation engine
│   │   ├── interaction/        # Polymorphic timeline events
│   │   └── safeguarding/
│   ├── integrations/           # One folder per external service
│   │   ├── stripe/
│   │   ├── gocardless/
│   │   ├── aircall/
│   │   ├── trengo/
│   │   ├── slack/
│   │   ├── asana/
│   │   ├── gmail/
│   │   └── booking/
│   ├── jobs/                   # Inngest functions
│   ├── ai/                     # OpenAI clients, prompts, classifiers
│   ├── audit/                  # AuditLogEntry writer, retention engine
│   └── ui/                     # Shared UI used in web (and future mobile)
├── docs/
│   ├── adr/                    # Architecture Decision Records
│   ├── runbooks/               # On call playbooks
│   └── compliance/             # GDPR, retention, DSAR procedures
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── .env.example
├── railway.json
├── Dockerfile
├── turbo.json                  # Turborepo
├── package.json
└── CLAUDE.md
```

**Module boundaries are enforced by ESLint `no-restricted-imports`.** `packages/core` cannot import from `packages/integrations`. `packages/integrations` cannot import from `apps/web`. Cross cutting code goes in `packages/core` or `packages/audit`.

---

## 6. Domain model (mental map before code)

Three concepts dominate everything.

### 6.1 Contact, Family, FinancialAccount

- **Contact** is one human: a parent, a student, a tutor, an LA caseworker.
- **Family** groups contacts that pay together or live together. A Family has one **billing contact** (usually a parent) and zero or more **student contacts**. A Family is the unit at which we reconcile money and hours.
- **FinancialAccount** is one per Family. It aggregates Stripe and GoCardless charges, booked hours from the booking site, and produces a single ledger view.

A Contact can exist without a Family (e.g. an unconverted lead). A student Contact must always belong to a Family before billing starts.

### 6.2 Interaction (the timeline)

Every email, call, message, note, task, payment, booking, and AI insight is an **Interaction**. The timeline view is `Interaction.findMany({ where: { contactId | familyId } }).orderBy({ occurredAt: desc })`.

Single polymorphic `Interaction` table with a `type` enum and a typed `payload` JSONB column, validated by Zod schemas per type. Trade-off documented in `docs/adr/0003-interaction-shape.md`.

### 6.3 The reconciliation triangle

```
        Booking site
         (hours)
            |
            |
Stripe ----+---- GoCardless
(£ paid)        (£ paid)
```

Every night we compare:
- Hours contracted vs hours booked vs hours delivered (from booking site).
- £ invoiced (Stripe + GoCardless + manual) vs £ collected vs £ refunded.
- Allocation of payments to bookings.

Discrepancies become `ReconciliationDiscrepancy` rows on the finance dashboard. Nothing is ever auto resolved.

### 6.4 Lifecycle states (the ones that matter)

**Family lifecycle.** `lead → trial → active → at_risk → churned`. Transitions are explicit; no row silently moves between states. The transition writes an Interaction of type `family.state_changed` with the previous state, new state, actor (user or `system`), and reason.

**Subscription state (Stripe mirror).** We mirror Stripe statuses verbatim: `trialing | active | past_due | canceled | unpaid | paused | incomplete | incomplete_expired`. Our `at_risk` Family flag is derived (`past_due` for >3 days, or two consecutive failed Direct Debits, or churn score above threshold).

**Mandate state (GoCardless mirror).** `pending_submission | submitted | active | failed | cancelled | expired | replaced`. A `replaced` mandate keeps a pointer to the new mandate; reconciliation walks the chain.

**Booking state (booking site mirror).** `tentative | confirmed | delivered | no_show | cancelled`. Hours only count toward delivery on `delivered`. `no_show` and `cancelled` have separate finance treatment defined in `packages/core/finance/booking-rules.ts`.

**Safeguarding flag.** `none | concern_logged | restricted_access`. A flag at `restricted_access` hides the contact's notes from everyone except the assigned DSL plus admins, and forces an audit prompt on every read.

---

## 7. Integrations: rules of engagement

Each integration lives in `packages/integrations/<service>/` with this shape:

```
packages/integrations/stripe/
├── client.ts          # Authenticated SDK client factory
├── webhook.ts         # Signature verification + payload normalisation
├── events/            # One file per event type we handle
│   ├── invoice-paid.ts
│   ├── invoice-payment-failed.ts
│   └── ...
├── jobs.ts            # Inngest functions that run after a webhook
├── outbound.ts        # Functions that call OUT to Stripe (create payment link, refund)
├── types.ts           # Domain mapped types (NOT raw Stripe types in the rest of the app)
└── README.md          # Service specific quirks, links to docs
```

### 7.1 Webhook handler pattern (every service follows this)

```ts
// app/api/webhooks/<service>/route.ts
export async function POST(req: Request) {
  // 1. Raw body — signature needs raw bytes, do NOT parse yet
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)

  // 2. Verify signature. Reject 400 if invalid.
  const event = verifyAndParse(raw, signature)
  if (!event) return new Response('invalid signature', { status: 400 })

  // 3. Persist raw event for audit and replay (idempotent on provider event id)
  await db.providerEvent.upsert({
    where: { provider_eventId: { provider: 'stripe', eventId: event.id } },
    create: { provider: 'stripe', eventId: event.id, type: event.type, raw, receivedAt: new Date() },
    update: {}, // dedupe on conflict
  })

  // 4. Enqueue async processing
  await inngest.send({ name: 'stripe/event.received', data: { eventId: event.id } })

  // 5. Return 2xx FAST (Stripe will retry on 5xx)
  return Response.json({ ok: true })
}
```

The Inngest function picks up the event, looks up the canonical object on Stripe (do not trust the webhook payload for state — refetch), updates our DB, writes audit entries, and emits domain events.

### 7.2 Why this shape, not something cleverer

We considered a generic webhook gateway with per-provider plugins. Rejected: each provider has unique signature, retry, ordering, and dedupe semantics that bleed through any abstraction. Per-provider folders keep those quirks local to the code that owns them, and the contract test fixtures live next to the handler.

---

## 8. Stripe playbook

**Verification.** Use `stripe.webhooks.constructEvent` with the endpoint signing secret from Railway env. Reject anything that fails signature with a 400; we never log the raw body of an unverified event because it may be hostile.

**No event ordering.** Stripe gives no ordering guarantee. Always refetch the canonical object before persisting our normalised view. The webhook tells us "something changed on object X"; the SDK call tells us what the truth currently is.

**Subscription statuses we care about:** `trialing | active | past_due | canceled | unpaid | paused | incomplete | incomplete_expired`. Each maps to a state in `packages/core/finance/subscription-state.ts`. New statuses introduced by Stripe must be added there explicitly — we fail closed (treat as `unknown`) rather than guess.

**Dunning.** Listen to `invoice.payment_failed` and `customer.subscription.updated` (status `past_due`). Do not build our own retry schedule — Stripe Smart Retries owns that. We surface state, raise a Family `at_risk` flag if appropriate, and notify the assigned ops agent through Trengo or Slack.

**Refunds.** All refunds go through `outbound.ts` and require an `IdempotencyKey` of `refund:<charge_id>:<reason_code>`. The function persists a `RefundIntent` first, then issues the API call, then writes the AuditLogEntry on success. A failed call leaves the intent in `pending_review` for finance to retry manually — never automatic.

**Payment Links** are the preferred way for agents to send a one off charge from inside the CRM. Created with metadata `{ familyId, contactId, agentId, reason }` so we can reconcile the resulting `checkout.session.completed`.

**Fixtures.** Sanitised replay events in `__tests__/fixtures/stripe/`. New event handlers ship with the fixture they were developed against.

---

## 9. GoCardless playbook

**Verification.** HMAC SHA-256 of the body using the webhook secret, in the `Webhook-Signature` header. A single request can contain multiple events in `events[]`. Loop and dedupe each on `(provider='gocardless', eventId=event.id)`.

**Late failures matter.** A Bacs payment can be `confirmed` and then later `failed` up to two business days later via the `late_failure_settled` event. Our reconciliation reverses the "paid" state when this fires and re-opens any allocation against bookings. We mark the parent `FinancialAccount` as `reverted_payment_pending_action` so finance can act before dunning kicks in.

**Mandate replacement.** Bacs mandates can be `replaced` — the mandate ID changes. Always follow `links.new_mandate` and update our `GcMandate` record, while keeping the old one with a `replacedById` pointer so historical events still resolve.

**Instalment schedules.** Listen for `errored` state and surface to finance immediately as a discrepancy with the booking it backs.

**Customer creation.** We do not create GoCardless customers from webhook flows. Customer + mandate creation happens in our flow when an agent (or the family via a hosted page link) confirms the bank details. The hosted page redirect URL embeds the `familyId`.

**Reconciliation.** Allocation of a payment to bookings is one-to-many. When a payment settles, the reconciliation job allocates against the oldest unallocated booking line first (FIFO), and creates `Allocation` rows. Manual override is allowed and audit-logged.

**Fixtures.** Sanitised payloads in `__tests__/fixtures/gocardless/`. Include both happy path and `late_failure_settled` to keep the reversal flow honest.

---

## 10. Aircall playbook

**Subscribed events:** `call.created`, `call.ringing_on_agent`, `call.answered`, `call.hungup`, `call.ended`, `call.voicemail_left`, `call.tagged`, `call.commented`. If AI Assist is enabled on the line, also `transcription.created`.

**Transcripts.** AI Assist gives us transcripts and summaries directly. If a line does not have AI Assist, we fall back: download `recording_url` from `call.ended`, push to S3 (`aircall/recordings/{call_id}`), send to Whisper via `packages/ai/transcribe.ts`, then to gpt-4o-mini for outcome classification (voicemail vs human, sentiment, suggested follow-up). The decision tree is in `packages/integrations/aircall/jobs.ts`.

**Disabled webhooks.** Aircall disables a webhook after 10 consecutive failures. We monitor failure rate per webhook in Axiom and re-enable through the Public API if it ever flips. Runbook: `docs/runbooks/aircall-webhook-disabled.md`.

**Recordings retention.** Deleting a recording in Aircall also deletes the transcript and AI insights forever. We persist a copy in S3 first if the parent contract requires retention beyond Aircall's window. The S3 bucket has bucket-level KMS encryption and lifecycle rules per contract.

**Linking calls to Contacts.** Match by E.164 phone number. If multiple Contacts share a number (rare — happens for shared family lines), we attach the call to the Family and prompt the agent to assign.

**Fixtures.** Real call payloads in `__tests__/fixtures/aircall/`. Numbers and names sanitised. Include voicemail and missed-call cases — they have different reconciliation rules than answered calls.

---

## 11. Trengo playbook

**Direction.** Two way: inbound via webhook, outbound via REST. Each agent uses their own Trengo API token (stored encrypted with KMS, scoped per user) so outbound messages preserve agent identity.

**Inbound webhook events:** new inbound message, new outbound message (so we capture replies sent from Trengo native UI), ticket assigned, ticket closed, ticket reopened, label added or removed.

**Contact matching.** Phone (E.164 normalised) first, email second. If neither matches, create a `Lead` row, not a `Contact`. Leads sit in the unassigned tray for an agent to triage. Never auto-create a Contact from an unmatched Trengo conversation — we have been bitten by spam routes creating ghost Contacts.

**Channels.** WhatsApp, SMS, email, web chat. Each has its own per-channel quirk (WhatsApp 24-hour window, SMS character cost, email threading via `Message-ID`). Channel-specific rules in `packages/integrations/trengo/channels/`.

**Outbound.** Always go through `outbound.ts` so we attach metadata (Interaction id, agent id) to the Trengo message custom fields. This lets us reconcile Trengo events back to our timeline without ambiguity.

**Token rotation.** Per-agent tokens rotate every 90 days. Renewal flow lives in agent settings; we surface a banner 14 days before expiry.

**Fixtures.** `__tests__/fixtures/trengo/`. Cover all four channel types and the `assigned/closed/reopened` lifecycle.

---

## 12. Slack playbook

**Auth.** Slack Events API with verified signing secret; we recompute the v0 signature and reject on mismatch. Replay protection: reject any request older than 5 minutes by `X-Slack-Request-Timestamp`.

**Subscribed events.** `message.channels` on the agreed list of channels only — never workspace-wide. The list lives in `packages/integrations/slack/config.ts` and changes ship via PR, never via the Slack admin UI.

**Summary parser.** A Slack message in a watched channel triggers an Inngest function that uses gpt-4o-mini to extract: candidate contact identifier (name, email, phone), summary text, sentiment, next action. The result becomes an Interaction of type `slack_summary` linked to the matched Contact.

**Confidence threshold.** If the AI cannot match a Contact with confidence above 0.7, the summary lands in an "unassigned summaries" tray for an agent to triage. Never auto-attach below threshold.

**Outbound.** We post status pings (e.g. dunning escalations) into a defined `#crm-alerts` channel via a single bot user. No DMs, no per-user posting.

---

## 13. Asana playbook

**Scope.** Two way but scoped to a defined set of projects, never the whole workspace. Project allowlist in `packages/integrations/asana/config.ts`.

**Webhooks.** Workspace-level webhooks with filters to limit noise. Respect Asana's 1000-webhook-per-resource limit. Webhook events are not replayable, so we persist every payload to `ProviderEvent` for our own replay.

**Handshake.** When Asana sends `X-Hook-Secret`, echo it back in the response header. Done in middleware on `/api/webhooks/asana`. Skipping this breaks webhook setup — failures show up in tests.

**CRM ↔ Asana linkage.** Each synced Asana task carries a custom field `crm_contact_id`. CRM tasks created from Asana copy this back so the link is reciprocal. Updates flow both ways but with last-writer-wins per field, with a clear log of who wrote what.

---

## 14. Gmail playbook

**Auth.** OAuth 2.0 per agent. Refresh tokens encrypted with KMS, never logged. Granular scopes only — `gmail.readonly`, `gmail.send`, `gmail.modify` (no full account access).

**Real-time push.** Google Cloud Pub/Sub `watch` for real-time delivery. Watch expires after 7 days, so we renew every 6 days via the `gmail/refresh-watch` job.

**Phase 1 scope.** Read sync, reply from CRM, sent items reflect in Gmail. **Not in phase 1:** labels, drafts, snooze, undo send, scheduled send. Phase 2.

**Threading.** Use Gmail's `thread_id` directly. Do not invent our own threading.

**Contact matching.** Match by `from`, `to`, `cc`, `bcc` addresses. Many to many — one email touches several Contacts. Persist all links so each Contact's timeline shows the full thread regardless of which address was matched.

**Attachments.** Stream to S3 on first sync; do not store payloads in Postgres. Reference by S3 key in `Interaction.payload`.

---

## 15. Booking site playbook (`booking.studymind.co.uk`)

**Sync.** REST API with a service account token. Pull every 5 minutes for active families, every hour for inactive. Use `If-Modified-Since` to be polite.

**Future.** Push from the booking site to a webhook here; documented in `docs/adr/0007-booking-push-vs-pull.md`. Until then, pulls are the contract.

**Hours model.** A booking has `contracted | scheduled | delivered | cancelled | no_show` per session. Only `delivered` counts toward billed hours. The reconciliation engine in `packages/core/finance/reconcile.ts` is the only consumer of this rule.

---

## 16. Zapier playbook

**Endpoint.** `/api/webhooks/lead` is a stable, versioned endpoint with a JSON schema documented in `docs/api/lead-webhook.md`.

**Auth.** Static bearer token rotated quarterly. Stored in Railway env, mirrored from 1Password.

**Schema discipline.** Additive only. Never remove or rename fields without bumping to `/api/webhooks/lead/v2`. Old endpoint stays alive for 12 months after a v2 ships.

**Trust.** Zapier is fine for partner integrations and lead capture. It is **not** the source of truth for anything financial, safeguarding, or operational. Anything critical lives in a first-party integration with full audit and contract tests.

---

## 17. Background jobs (Inngest)

Every async unit of work is an Inngest function. Conventions:

- Function ID is `<domain>/<action>` (e.g. `finance/reconcile-family`, `ai/classify-call-outcome`).
- Use `step.run` for each external call so retries are granular.
- Use `step.sleep` for delays, never `setTimeout`.
- Concurrency limits per function. Default `{ limit: 10 }`. AI heavy: `{ limit: 3 }` to respect rate limits.
- Idempotency key: every external mutation (refund, send message, create payment link) carries a key derived from `(domain entity id, action, day)` so retries do not double-act.
- Every step that calls an external service tags the OpenTelemetry span with `provider`, `endpoint`, `entity_id`. Sentry breadcrumbs read those tags on error.

### 17.1 Recurring jobs

| Job | Schedule | Purpose |
|---|---|---|
| `finance/reconcile-all-families` | nightly 02:00 UTC | Walk every active Family, raise discrepancies |
| `ai/score-churn-risk` | nightly 03:00 UTC | Score every Family, create retention tasks above threshold |
| `compliance/enforce-retention` | nightly 04:00 UTC | Soft delete or hard delete data per RetentionPolicy |
| `compliance/audit-log-archive` | weekly Sunday 05:00 | Archive AuditLogEntry older than 12 months to cold storage |
| `gmail/refresh-watch` | daily 06:00 UTC | Renew Gmail Pub/Sub watch for every connected mailbox |
| `booking/sync-active-families` | every 5 min | Pull booking changes for active Families |
| `booking/sync-inactive-families` | hourly | Pull booking changes for inactive Families |
| `ai/regenerate-status-summaries` | every 30 min for changed contacts | Refresh the 2 sentence "Current Status" header |
| `aircall/recover-disabled-webhook` | hourly | Re-enable Aircall webhook if it was disabled by failures |
| `gocardless/reconcile-late-failures` | every 4 hours | Walk recent confirmations and surface any new late failures |

### 17.2 Failure semantics

A failed step retries with exponential backoff up to 6 attempts. After exhaustion the function lands in the dead-letter view with the original event payload. Dead-lettered events are surfaced in the on-call dashboard; we never silently drop work. Replays are explicit, audit-logged, and idempotent.

---

## 18. AI workflows

OpenAI for everything AI today. Models per task:

| Task | Model | Why |
|---|---|---|
| Call outcome classification (voicemail vs human) | gpt-4o-mini | Cheap, binary plus a label |
| Slack summary parser | gpt-4o-mini | Structured extraction, low stakes |
| Contact merge suggestion | gpt-4o-mini | Fast, surfaces candidates only — humans decide |
| Status summary (2 sentence header) | gpt-4o-mini | High volume, low complexity |
| Reply draft (email and Trengo) | gpt-4o | Quality matters, agent reads and edits |
| Tender response drafting | gpt-4o | High stakes, long form, references house style |
| Intent classifier (inbound message) | gpt-4o-mini | Routes to right team |
| Churn score | gpt-4o-mini | Aggregates signals into a score |
| Audio transcription (Aircall fallback) | Whisper | Only used when AI Assist not available |

### 18.1 Prompt rules

- Every prompt lives in `packages/ai/prompts/<task>.ts` as a typed function. No prompts inline in handlers.
- Every AI call has a Zod output schema. We use `response_format: json_schema` (Structured Outputs) where possible so the model returns parseable JSON.
- Every AI call logs: model, prompt version, input token count, output token count, latency, cost estimate, outcome.
- Never feed safeguarding fields into a prompt. Those are encrypted; AI cannot see them.
- Temperature defaults to 0.2 unless the task is creative drafting (then 0.7).

### 18.2 Confidence and human in the loop

- AI output below the task threshold lands in a triage queue, not in production data.
- Merge suggestions, intent routing for safeguarding, and tender drafts are always human reviewed before they take effect.
- "Confidence" is task-specific. For classifiers we use the model's logprob proxy; for extraction we score on schema completeness and presence of required fields.

### 18.3 AI safety and evaluation

- **Prompt versioning.** Every prompt has a semantic version; production calls record the version used. Rolling out a new prompt is a code change, reviewed and deployed via the normal pipeline. No live prompt edits in production.
- **Eval harness.** `packages/ai/evals/` holds sets of fixtures and expected outputs per task. CI runs evals on every PR that touches `packages/ai/`. A regression beyond the per-task tolerance fails the build.
- **Drift detection.** Production samples a fraction of AI outputs into `packages/ai/evals/drift/` automatically. Reviewers triage weekly; a confirmed drift opens a prompt issue.
- **Red team.** Quarterly we run an internal red team pass: prompt injection, jailbreak attempts, PII leakage, and safeguarding bypass via creative input. Findings become test cases.
- **Cost guardrail.** A daily cap per task category in `packages/ai/budget.ts`. Exceeding the cap puts the task into a degraded mode (skip, queue, or fall back to mini) and pages finance + tech lead.
- **No PII in prompts unless necessary.** When sending family-identifying data, redact what is not needed. Email addresses and minor names are minimised.
- **Logging.** AI logs are kept 90 days in Axiom and indexed by `prompt_version` and `task`. Beyond that, samples kept for evals only, with names redacted.
