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
- Account owners and senior team — pipeline, retention, partnerships
- Designated Safeguarding Lead (DSL) — safeguarding flags, restricted notes

Parents, students, tutors do **not** log in. They use the booking site, Trengo, email, phone.

> **TOP PRIORITY INITIATIVE — Communications Hub (Gmail replacement).** Much of
> the CRM already exists; the highest-value work now is the **Email &
> Communications Operating System**, not more CRM surface. The goal in one line:
> **build a Gmail replacement that stays fully synchronised with Gmail** — staff
> can spend the whole day in the CRM and never open Gmail, and if they do open
> Gmail everything stays in step. The CRM and the mailbox become two interfaces
> onto the same data. This means: **multi-account, multi-provider** (Gmail,
> Workspace, Outlook 365, Exchange, IMAP — no practical limit on connected
> inboxes), **true two-way sync** (mail, sent, drafts, read/unread, labels,
> folders, stars, archive, delete, threading — both directions, near-real-time),
> a **full email client** (Gmail/Superhuman class), **shared team inboxes** with
> assign/claim/transfer/notes/@mentions, **auto-linking** every message to the
> existing Lead/Contact/Family (no duplicate records), and a path to fold
> WhatsApp/Trengo/SMS/social into one unified conversation list. **Reuse what
> exists — do not rebuild it.** Architecture and the phased plan: **ADR 0021**;
> the email playbook is §14. Phase 1 (the provider-agnostic multi-account
> foundation: `MailAccount`/`MailAccountMember`, Settings → Email accounts) is
> implemented.

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
| Auth | Auth.js v5 (next-auth) — self-hosted, Postgres-backed | Email + bcrypt password, optional TOTP MFA, sessions in our DB; no third-party processor for staff identity (ADR 0010) |
| File and audio storage | AWS S3 (eu-west-2) | Call recordings, email attachments, DSAR exports |
| Encryption (field level) | AWS KMS envelope encryption | Safeguarding notes, EHCP extracts |
| Email transactional | Gmail API (Google OAuth) | Outbound system email (account welcome, password reset, forwarding) sent from the configured system mailbox via `packages/integrations/gmail/src/system-send.ts`. **No third-party email API — never use Resend.** |
| Observability | Sentry (errors), Axiom (logs), OpenTelemetry traces | Required from day one |
| AI | Google Gemini (default) — 2.5 Flash for most, Pro override for drafts; OpenAI (gpt-4o / gpt-4o-mini / Whisper) as switchable fallback. ADR 0028 | One provider seam in `packages/ai`; flip via `AI_PROVIDER` / `GEMINI_API_KEY`, no call-site changes |
| Hosting | Railway (services: web, worker, postgres; Redis via Railway plugin) | Single platform for the whole stack |
| Cache and rate limit | Redis on Railway (Upstash compatible) | Inngest queue, rate limit windows, response cache |

**No new dependencies without an ADR.** See `docs/adr/`.

> **Hosting note.** Frontend and backend live in this Next.js app on Railway. We do not use Supabase, Firebase, or any BaaS. Postgres is owned by us on Railway; row level security is enforced at the application layer through tRPC procedures and `packages/core/auth/policies.ts`, not in the database.

---

## 4. Brand and product identity

The CRM is internal but it is the daily workspace for the people speaking to families on our behalf. The interface should feel like StudyMind — calm, careful, expert — so that tone carries into every email, call, and Trengo message agents send from inside it.

**Voice.** Warm, professional, and specific. We write to parents and Local Authorities with care. We avoid jargon when speaking to families and use precise statutory language (EHCP, Section 19, SEND) when speaking to Local Authorities. Never patronising, never breezy about safeguarding.

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
│       │   ├── (auth)/         # NextAuth v5 sign-in / sign-up / verify (ADR 0010)
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
│           ├── trpc/           # client + server helpers, procedure builders
│           ├── view-models/    # RSC-side shapers consumed by client components
│           └── hooks/          # shared client hooks
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

**Billing contact changes.** Switching the billing contact on a Family (mid-term separation, grandparent takes over) is an explicit `family.billing_contact_changed` Interaction with reason and effective date. Open Stripe subscriptions and GoCardless mandates do **not** auto-transfer — finance manually re-issues. Runbook: `docs/runbooks/billing-contact-change.md`.

### 6.2 Interaction (the timeline)

Every email, call, message, note, task, payment, booking, and AI insight is an **Interaction**. The timeline view is `Interaction.findMany({ where: { contactId | familyId } }).orderBy({ occurredAt: desc })`.

Single polymorphic `Interaction` table with a `type` enum and a typed `payload` JSONB column, validated by Zod schemas per type. Trade-off documented in `docs/adr/0003-interaction-shape.md`.

**Channel-specific view-models (ADR 0017).** The comprehensive customer view does not render the raw polymorphic list — it reshapes Interactions per channel in `apps/web/lib/view-models/contact-channels.ts` (email threads grouped by `payload.gmailThreadId`, calls with outcome + recording, Slack mentions, Trengo conversations grouped by `payload.ticketId` with the WhatsApp 24h deadline, tasks, notes), exposed via the `contact.channels.*` tRPC namespace. Partial indexes on `Interaction(contactId, type, occurredAt DESC)` and the two JSONB grouping keys keep these reads cheap. The flat timeline remains as a fallback section.

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

**Family lifecycle.** Operator-managed dynamic pipeline (ADR 0015). Each Family points at a `PipelineStage` row via `Family.stageId`. CEO and Senior Manager can create, rename, recolour, reorder, archive (with mandatory family-reassignment when occupied), and restore stages from `/pipeline/manage`. Sales Executive and above can move a Family between stages via the per-card "Move to…" dropdown on the kanban. Each move writes a `family_pipeline_moved` Interaction (with `{fromStageId, toStageId, fromState, toState}`) and an audit row in one transaction — transitions are never silent.

The legacy `FamilyState` enum (`lead | trial | active | at_risk | churned`) is **deprecated but retained** per §19 forward-only. `moveFamily` mirrors the new stage name back into `Family.state` on a best-effort basis when the name maps to a known enum value (`mirrorStateForStage` in `packages/core/pipeline/stages.ts`). Consumers that still read `state` — the at-risk derivation, the churn-score job, the reconciliation engine — keep working; for custom stage names the column becomes stale and those derivations reflect the family's last legacy state until a follow-up PR retires the column.

**Boards and Cards (ADR 0018).** The single pipeline above is generalised into multiple operator-managed **Boards**, each owning its own `PipelineStage` rows (now scoped by `boardId`) and **Card** rows. A Card is backed by a `Contact` (lighter than a Family, which remains the billing unit) and carries an optional `Subject` and any number of coloured `Label`s. Board management (create/rename/reorder/archive) is CEO + Senior Manager; card CRUD and moves are Sales Executive and above; Virtual Assistant is read-only. A card move writes a `card_moved` Interaction on the backing contact plus an audit row. `Family.stageId` is retained for finance/at-risk; `Card.stageId` drives the board display. `/pipeline` redirects to the default board (`/boards/<defaultBoardId>`). Domain: `packages/core/src/board/`; tRPC: `board.*`, `card.*`, `label.*`, `subject.*`, `boardQuickAction.*`; UI: `apps/web/app/(app)/boards/`. The board kanban supports drag-and-drop card moves via @dnd-kit (ADR 0019); the per-card **Move to…** dropdown supports cross-board moves (when the picked target stage lives on another board, the card's `boardId` is updated atomically alongside the stage swap). The whole card body is clickable and opens a detail modal. From a card an agent can record a **call summary** (`call_summary` Interaction on the backing contact) and **send** it best-effort to Slack / Trengo / email (`card.callSummary.{add,send}`); the send records a `call_summary_sent` Interaction with a per-channel result map.

**Configurable per-card quick actions.** Replaces the legacy single-tick / single-X pair on `Board` (those columns are retained per §19 forward-only but the default board's seed clears them). Each `BoardQuickAction` row defines a chip that appears on every card on the board: it has its own label, colour, target stage (optionally on another board → cross-pipeline routing), and optional comment template. Clicking the chip fires `card.applyQuickAction` which adds the templated comment to the card and moves it to the target stage in one audited operation. CRUD lives in `/boards/[boardId]/settings` (Manager+); firing is Sales Executive+. Default board seeds three buttons (Called once, Called twice, Call completed) plus the user's preferred column layout (New leads · Scheduled 9am-1pm / 1pm-4pm / 4pm-8pm · Called once · Called twice · Never answered · Call completed).

**Subscription state (Stripe mirror).** We mirror Stripe statuses verbatim: `trialing | active | past_due | canceled | unpaid | paused | incomplete | incomplete_expired`. Our `at_risk` Family flag is derived (`past_due` for >3 days, or two consecutive failed Direct Debits, or churn score above threshold).

**Mandate state (GoCardless mirror).** `pending_submission | submitted | active | failed | cancelled | expired | replaced`. A `replaced` mandate keeps a pointer to the new mandate; reconciliation walks the chain.

**Booking state (booking site mirror).** `tentative | confirmed | delivered | no_show | cancelled`. Hours only count toward delivery on `delivered`. `no_show` and `cancelled` have separate finance treatment defined in `packages/core/finance/booking-rules.ts`.

**Safeguarding flag.** _DEPRECATED — see ADR 0013._ The `SafeguardingFlag` table is retained as an orphan; no v1 code path reads or transitions it.

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

**Latency budget.** The handler itself returns within 500 ms (90p) — measured at the edge. The end-to-end normalised-write SLO of 30 s (Section 25.1) is the Inngest job's responsibility, not the handler's. Do not log the raw body of an unverified event; it may be hostile (Section 8).

The Inngest function picks up the event, looks up the canonical object on Stripe (do not trust the webhook payload for state — refetch), updates our DB, writes audit entries, and emits domain events.

### 7.2 Why this shape, not something cleverer

We considered a generic webhook gateway with per-provider plugins. Rejected: each provider has unique signature, retry, ordering, and dedupe semantics that bleed through any abstraction. Per-provider folders keep those quirks local to the code that owns them, and the contract test fixtures live next to the handler.

---

## 8. Stripe playbook

**Verification.** Use `stripe.webhooks.constructEvent` with the endpoint signing secret from Railway env. Reject anything that fails signature with a 400; we never log the raw body of an unverified event because it may be hostile.

**No event ordering.** Stripe gives no ordering guarantee. Always refetch the canonical object before persisting our normalised view. The webhook tells us "something changed on object X"; the SDK call tells us what the truth currently is.

**Subscription statuses we care about:** `trialing | active | past_due | canceled | unpaid | paused | incomplete | incomplete_expired`. Each maps to a state in `packages/core/finance/subscription-state.ts`. New statuses introduced by Stripe must be added there explicitly — we fail closed (treat as `unknown`) rather than guess.

**Dunning.** Listen to `invoice.payment_failed` and `customer.subscription.updated` (status `past_due`). Do not build our own retry schedule — Stripe Smart Retries owns that. We surface state, raise a Family `at_risk` flag per the derivation in Section 6.4 (`packages/core/finance/at-risk.ts` is the single implementation), and notify the assigned ops agent through Trengo or Slack.

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

**Contact matching.** Phone (E.164 normalised) first, email second. If neither matches, create a `Lead` row, not a `Contact`. Leads sit in the unassigned tray for an agent to triage. Never auto-create a Contact from an unmatched Trengo conversation — we have been bitten by spam routes creating ghost Contacts. (The **web-lead funnel** `/api/leads` is a deliberate exception that *does* auto-onboard, with a 24h dedupe + email/phone gate as the anti-spam control — see §16 and ADR 0023. This Trengo rule is unchanged.)

**Channels.** WhatsApp, SMS, email, web chat. Each has its own per-channel quirk (WhatsApp 24-hour window, SMS character cost, email threading via `Message-ID`). Channel-specific rules in `packages/integrations/trengo/channels/`.

**Outbound.** Always go through `outbound.ts` so we attach metadata (Interaction id, agent id) to the Trengo message custom fields. This lets us reconcile Trengo events back to our timeline without ambiguity. Agents reply to a conversation from the CRM via `interaction.trengo.reply` (Sales Executive+; Virtual Assistant cannot send), which resolves the contact's active ticket+channel via the shared `resolveActiveTrengoConversation` helper (`packages/integrations/trengo/src/conversations.ts`) and calls `sendMessage`. The roadmap to a full two-way operational layer (conversation head, real-time SSE, Communication Centre, assign/close/tag sync) is ADR 0020 + `docs/audit/trengo-operational-layer-audit.md`.

**Token rotation.** Per-agent tokens rotate every 90 days. Renewal flow lives in agent settings; we surface a banner 14 days before expiry. **Expired tokens fail closed:** outbound aborts with a `TOKEN_EXPIRED` BusinessError, the Interaction stays in `pending_send`, and the agent sees an inline banner. We never fall back to a shared service token — it would break agent attribution.

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

## 14. Email & Communications Hub playbook (Gmail today)

This section is the email engine of the **Communications Hub** top-priority
initiative (see §1 callout and **ADR 0021**). The target is a Gmail-class client
inside the CRM that stays fully two-way-synchronised with the real mailbox,
across many accounts and many providers. Gmail is the only live provider today;
the design is provider-agnostic so Outlook/Exchange/IMAP slot in without
touching the domain.

**The connected-inbox unit is `MailAccount` (ADR 0021), not `GmailMailbox`.**
`MailAccount` is provider-agnostic (`provider ∈ gmail|google_workspace|outlook|exchange|imap`),
is either `personal` (one agent) or `shared` (a team inbox: info@, admissions@,
…), and carries generic sync state (`syncCursor`, `watchExpiresAt`,
`lastSyncedAt`). Shared-inbox access is granted via `MailAccountMember` (mirrors
`TeamMember`); an optional `teamId` ties it to an ops `Team`. For `provider=gmail`
a row **bridges** to the legacy `GmailMailbox` via `gmailMailboxId`, so the live
Gmail sync below is reused with no destructive migration (§19.1). **Secrets
(OAuth refresh tokens, IMAP passwords) never live on `MailAccount` — they stay in
`EncryptedField` (§21).** Domain: `packages/core/src/mail`; tRPC: `mailAccount.*`;
UI: Settings → Email accounts (`/settings/email-accounts`). The provider
capability registry (`MAIL_PROVIDERS`) is the single source of which providers
are connectable today — we **fail closed** (§8): only `gmail` is connectable; the
rest advertise the roadmap and reject connection attempts.

**Phased plan (ADR 0021):** (1) multi-account foundation — *implemented*;
(2) `MailSyncProvider` seam + Gmail behind it — *implemented*; (3) email into the
`Conversation` head + Communication Centre (unified inbox) — *implemented*;
(4) `/mail` client — *v1 + compose/reply/search implemented* (bulk / preview /
shortcuts still to come); (5) two-way action sync
(read/archive/star/label/delete) — *implemented* (outbound CRM→Gmail; inbound
flag-mirroring + drafts still to come); (6) shared-inbox operations — *implemented*
(assign already existed; + notes/@mentions + one-click task-from-conversation);
(7) Outlook/Exchange/IMAP providers — design in **ADR 0024** (deps not added
until approved); (8) templates, automations, analytics, calendar, unified
channels.

### Gmail provider specifics (live today)

**Auth.** OAuth 2.0 per agent. Refresh tokens encrypted with KMS, never logged. Granular scopes only — `gmail.readonly`, `gmail.send`, `gmail.modify` (no full account access).

**Real-time push.** Google Cloud Pub/Sub `watch` for real-time delivery. Watch expires after 7 days, so we renew every 6 days via the `gmail/refresh-watch` job.

**Sync surface today.** Read sync, reply from CRM, sent items reflect in Gmail, attachments, 90-day backfill. Labels/drafts/snooze/archive/delete two-way mirroring is ADR 0021 Phase 5 — not yet live.

**Threading.** Use Gmail's `thread_id` directly. Do not invent our own threading.

**Contact matching.** Match by `from`, `to`, `cc`, `bcc` addresses. Many to many — one email touches several Contacts. Persist all links so each Contact's timeline shows the full thread regardless of which address was matched. Unmatched mail must **never** auto-create a Contact (§11 rule, applied to email — create a `Lead` instead).

**Attachments.** Stream to S3 on first sync; do not store payloads in Postgres. Reference by S3 key in `Interaction.payload`.

---

## 15. Booking site playbook (`booking.studymind.co.uk`)

**Shape: student-centric (ADR 0029).** The booking site is the source of truth for **students** (each with an optional guardian/bill-payer, an hours balance with expiry, and MMI/Live-Day **credits**), **lessons** (tutor, subject, start/end, status, payment, trial feedback), and two ledgers (balance history, credit history). A booking student maps to a `Contact` (`kind = student`) keyed on `Contact.bookingContactId = <booking uuid>`; the richer data hangs off that Contact in `ContactBookingProfile` (1:1 — guardian, hours summary, credit balances), `BookingLesson`, `BookingHoursTransaction`, and `BookingCreditTransaction` (§19.2). Lessons also land as `booking` Interactions on the timeline. The legacy family-centric `Booking`/`BookingSession` tables coexist for now (the reconciliation engine still reads them); wiring lessons into reconciliation is a follow-up. **We never auto-merge contacts** (§3): match on `bookingContactId`, else a single unambiguous email/phone match, else create.

**Sync.** Read-only **incremental pull** with a service-account Bearer token (ADR 0007 — pull-first; webhooks are a later phase). Each resource keeps its own global keyset cursor (`BookingSyncCursor`): a poll asks "what changed since X?", keyset-paginated and bounded per tick, so load stays flat regardless of student count — **never one request per student**. Jobs: `booking/sync-students` + `booking/sync-lessons` every 5 min, `booking/sync-balance-ledger` + `booking/sync-credit-ledger` every 15 min (§17.1). The jobs **no-op when `BOOKING_API_TOKEN` is unset**, so the CRM is safe to run before the booking team exposes the API. The contract the booking team must build is `docs/api/booking-pull-api.md`. Integration: `packages/integrations/booking/` (`client.ts`, `student-sync.ts`, `jobs.ts`).

**Fail-closed.** The one closed enum (credit kind) fails closed on unknown values (§8); lesson status/payment and ledger `type` are stored as normalised text until the booking team confirms the value sets (`docs/api/booking-pull-api.md` §2.3), so a new value never blocks a sync.

**Future.** Push from the booking site to a webhook here; documented in `docs/adr/0007-booking-push-vs-pull.md`. Until then, pulls are the contract.

**Hours model.** A booking has `contracted | scheduled | delivered | cancelled | no_show` per session. Only `delivered` counts toward billed hours. The reconciliation engine in `packages/core/finance/reconcile.ts` is the only consumer of this rule.

---

## 16. Lead capture (Zapier + universal endpoint)

**Universal endpoint (ADR 0023).** `POST /api/leads` is the dynamic ingestion engine for Contact Form 7 and any other source. It accepts JSON, form-encoded, multipart, and CF7 webhooks with **any** field names — never hardcode CF7 field ids (`text-618`, `tel-146`). A pure normaliser (`packages/core/src/lead/normalise.ts`) detects each field's role from `webhook:<role>` mappings → name synonyms → CF7 type prefixes → value sniffing, and lifts landing-page intelligence (domain, slug, form title, UTM). The thin handler authenticates by a per-site `LeadSource` API key (or the global fallback token), persists raw → `ProviderEvent` + `Lead`, audits, and enqueues `lead/classify.requested`. Async, the classify job classifies (brand → `Company`, products/categories from configurable `BrandDomainRule`/`UrlClassificationRule`/`ProductCatalogueItem`, score, advisory AI summary) and routes onto the Sales Pipeline. Contract: `docs/api/leads-endpoint.md`. UI: Settings → Integrations → Lead webhook (URL, API keys, test generator) + the Leads tray (`/leads`).

**Auto-onboarding + dedupe (overrides §11 for web leads).** First enquiry auto-creates a Contact (brand-tagged) + a card on the default board's "New leads" stage. A re-enquiry matched by email/phone never creates a duplicate Contact — it annotates the existing contact and adds a fresh card only if >24h since the last enquiry (within 24h is one card, anti-spam). A submission with neither email nor phone, or an ambiguous match, goes to the Leads tray instead of creating a ghost contact. Matching never auto-merges (§41.1). This is the deliberate web-lead exception to "never auto-create a Contact" (ADR 0023).

**Legacy Zapier endpoint.** `/api/webhooks/lead` (+`/v2`) is the older stable, versioned bearer-token endpoint with a fixed JSON schema (`docs/api/lead-webhook.md`). Additive only; bump to `/v2` for breaking changes; old endpoint stays alive 12 months. It remains for existing Zaps; new integrations use `/api/leads`.

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
- **Where functions live.** Integration-specific Inngest functions live in `packages/integrations/<service>/jobs.ts` (close to the webhook that triggers them). Cross-cutting and recurring functions (reconciliation, retention, churn scoring) live in `packages/jobs/`. Section 37 reflects the cross-cutting case.

### 17.1 Recurring jobs

| Job | Schedule | Purpose |
|---|---|---|
| `finance/reconcile-all-families` | nightly 02:00 UTC | Walk every active Family, raise discrepancies |
| `ai/score-churn-risk` | nightly 03:00 UTC | Score every Family, create retention tasks above threshold |
| `compliance/enforce-retention` | nightly 04:00 UTC | Soft delete or hard delete data per RetentionPolicy |
| `compliance/audit-log-archive` | weekly Sunday 05:00 | Archive AuditLogEntry older than 12 months to cold storage |
| `gmail/refresh-watch` | daily 06:00 UTC | Walks every connected mailbox; renews any watch within 24 h of expiry. Watch lifetime is 7 days, target renewal at 6 days (Section 14). |
| `booking/sync-students` | every 5 min | Pull changed students from booking.studymind.co.uk → Contacts (ADR 0029) |
| `booking/sync-lessons` | every 5 min | Pull changed lessons → `BookingLesson` + timeline Interactions |
| `booking/sync-balance-ledger` | every 15 min | Pull the hours-balance ledger → `BookingHoursTransaction` |
| `booking/sync-credit-ledger` | every 15 min | Pull the credit ledger → `BookingCreditTransaction` |
| `ai/regenerate-status-summaries` | every 30 min for changed contacts | Refresh the 2 sentence "Current Status" header |
| `aircall/recover-disabled-webhook` | hourly | Re-enable Aircall webhook if it was disabled by failures |
| `gocardless/reconcile-late-failures` | every 4 hours | Walk recent confirmations and surface any new late failures |
| `trengo/retry-pending-send` | every 5 min | Re-send outbound Trengo Interactions stuck in `pending_send` (ADR 0020 Phase 7a). Bounded at 5 attempts per row; skips TOKEN_EXPIRED (the agent must reconnect). |

**Event-triggered backfill workers (ADR 0017).** Not recurring — fired once on first-connect (Gmail/Trengo) or by an admin button (Aircall/Slack). `gmail/backfill.requested`, `aircall/backfill.requested`, `trengo/backfill.requested`, `slack/backfill.requested` each pull the last 90 days of history and write retroactive Interactions for matched Contacts. Idempotent on the provider's native id; concurrency-capped (Slack 3 as it is AI-heavy, others 2). One summary audit row per job — never per imported message.

**Lead classify + route (`lead/classify.requested`).** Event-triggered, not cron — fired by the universal `/api/leads` endpoint (and the legacy lead webhook path) once per submission (ADR 0023, §16). The pure orchestration is `packages/jobs/src/leads/process-lead.ts`; the worker boundary (`apps/web/app/api/inngest/_boundary/process-lead.ts`) injects the advisory AI enrichment. Normalises → classifies (rules + optional AI) → matches/onboards a Contact → routes onto the Sales Pipeline with the 24h re-enquiry dedupe. Idempotent (skips once `Lead.classifiedAt` is set); concurrency-capped at 3 (AI-touching). Pure decisions live in `packages/core/src/lead/`.

**Direct Debit defaulter scan (`finance/flag-dd-defaulters`).** Event-triggered, not cron — runs on `finance/reconcile.completed` (§17.3) so it reads consistent invoice/payment state. Recomputes the GoCardless defaulter set (`listDefaulters` in `packages/core/src/finance/dd-defaulters.ts`) and raises a `direct_debit_default` `ReconciliationDiscrepancy` (idempotent on `(familyId, category, contextHash)`) for any newly-defaulted family; the pure aggregator is `packages/jobs/src/finance/flag-dd-defaulters.ts`. The worker boundary (`apps/web/app/api/inngest/_boundary/flag-dd-defaulters.ts`) posts a summary to `#crm-finops`. Read-only analysis — never auto-charges or auto-duns (§3). Surfaced at `/finance/direct-debit`; per-customer payments are surfaced on the Family and Contact pages via `finance.customerPayments.*` (`packages/core/src/finance/customer-payments.ts`).

### 17.2 Failure semantics

A failed step retries with exponential backoff up to 6 attempts. After exhaustion the function lands in the dead-letter view with the original event payload. Dead-lettered events are surfaced in the on-call dashboard; we never silently drop work. Replays are explicit, audit-logged, and idempotent.

### 17.3 Job ordering

`compliance/enforce-retention` and `ai/score-churn-risk` depend on `finance/reconcile-all-families` completing. They use `step.waitForEvent('finance/reconcile.completed')` rather than wall-clock scheduling, so a slow reconciliation never causes a downstream job to read inconsistent state.

---

## 18. AI workflows

**Provider: Google Gemini by default, OpenAI as switchable fallback (ADR 0028).**
All AI runs through `packages/ai` behind `runStructured` / `runDraft` /
`transcribeAudio`; the provider + concrete model are resolved centrally in
`packages/ai/src/clients/models.ts`. Call sites still pass the legacy model
literals below — they are now **tier hints**: `gpt-4o-mini` → the `mini` tier,
`gpt-4o` → the `standard` tier. Both tiers default to **Gemini 2.5 Flash**
("flash for most"); promote the standard tier to `gemini-2.5-pro` for drafts via
`GEMINI_MODEL_STANDARD` with no code change. Flip provider with `AI_PROVIDER`
(or just set `GEMINI_API_KEY`). The "Model" column is the tier hint per task:

| Task | Tier hint | Why |
|---|---|---|
| Call outcome classification (voicemail vs human) | gpt-4o-mini (mini) | Cheap, binary plus a label |
| Slack summary parser | gpt-4o-mini (mini) | Structured extraction, low stakes |
| Contact merge suggestion | gpt-4o-mini (mini) | Fast, surfaces candidates only — humans decide |
| Status summary (2 sentence header) | gpt-4o-mini (mini) | High volume, low complexity |
| Reply draft (email and Trengo) | gpt-4o (standard) | Quality matters, agent reads and edits |
| Intent classifier (inbound message) | gpt-4o-mini (mini) | Routes to right team |
| Churn score | gpt-4o-mini (mini) | Aggregates signals into a score |
| Audio transcription (Aircall fallback) | Gemini multimodal / Whisper | Provider-routed; only when AI Assist not available |

### 18.1 Prompt rules

- Every prompt lives in `packages/ai/prompts/<task>.ts` as a typed function. No prompts inline in handlers. Tone/style fragments live in `packages/ai/prompts/style/` and are imported by task prompts. Tasks never inline style copy.
- Every AI call has a Zod output schema. Use `response_format: json_schema` (Structured Outputs) for all classification and extraction tasks. Drafting tasks (e.g. reply drafts) return free text and are validated post-hoc with a content-shape Zod schema (length, no PII leak markers). The two patterns are implemented in `packages/ai/clients/structured.ts` and `packages/ai/clients/draft.ts`; do not call OpenAI directly.
- Every AI call logs: model, prompt version, input token count, output token count, latency, cost estimate, outcome.
- Never feed safeguarding fields into a prompt. Those are encrypted; AI cannot see them.
- Temperature defaults to 0.2 unless the task is creative drafting (then 0.7).

### 18.2 Confidence and human in the loop

- AI output below the task threshold lands in a triage queue, not in production data.
- Merge suggestions and intent routing for safeguarding are always human reviewed before they take effect.
- "Confidence" is task-specific. For classifiers we use the model's logprob proxy; for extraction we score on schema completeness and presence of required fields.

### 18.3 AI safety and evaluation

- **Prompt versioning.** Every prompt has a semantic version; production calls record the version used. Rolling out a new prompt is a code change, reviewed and deployed via the normal pipeline. No live prompt edits in production.
- **Eval harness.** `packages/ai/evals/` holds sets of fixtures and expected outputs per task. CI runs evals on every PR that touches `packages/ai/`. A regression beyond the per-task tolerance fails the build.
- **Drift detection.** Production samples a fraction of AI outputs into `packages/ai/evals/drift/` automatically. Reviewers triage weekly; a confirmed drift opens a prompt issue.
- **Red team.** Quarterly we run an internal red team pass: prompt injection, jailbreak attempts, PII leakage, and safeguarding bypass via creative input. Findings become test cases.
- **Cost guardrail.** A daily cap per task category in `packages/ai/budget.ts`. Exceeding the cap puts the task into a degraded mode (skip, queue, or fall back to mini) and pages finance + tech lead.
- **No PII in prompts unless necessary.** When sending family-identifying data, redact what is not needed. Email addresses and minor names are minimised.
- **Logging.** AI logs are kept 90 days in Axiom and indexed by `prompt_version` and `task`. Beyond that, samples kept for evals only, with names redacted.

---

## 19. Database conventions (Prisma)

- All IDs are `cuid2`. No incrementing integers in user-facing URLs.
- Every table has `createdAt`, `updatedAt`, `createdById`, `updatedById` (nullable for system writes).
- Soft delete: `deletedAt DateTime?` instead of `DELETE`. Hard delete only via the retention engine.
- JSONB columns are typed via Zod schemas in `packages/core/<domain>/types.ts`.
- Indices are explicit. Run `pnpm db:explain` on every new query that hits a table over 100k rows. Add the index in the same migration.
- Migrations are forward only. No down migrations in production.
- **Never run `prisma db push` against any environment except local.** Always go through `prisma migrate dev` then `prisma migrate deploy`.
- Foreign keys are real foreign keys, not application-level associations. We rely on Postgres referential integrity.
- Money is stored as integer minor units (pence) in a column suffixed `_minor`. No floats for money, ever.
- Time is stored UTC. Locales are derived at the edge.
- **Enum changes.** Postgres enums are append-only in a single migration; renames or removals require a two-PR shadow-column dance. New Stripe/GoCardless states added by the provider are added explicitly here — we fail closed on unknown values (Section 8).

### 19.1 Backfills

- Backfills run as Inngest jobs (`migrations/<name>`), batched (default 1000 rows), with a `pg_advisory_lock` so two runners cannot race.
- Schema additions are made in two PRs: (1) add the column, default null, deploy; (2) backfill via job; (3) optional follow-up to mark NOT NULL once the backfill is done. Never combine schema and backfill in a single migration that blocks deploy.

### 19.2 Schema reference (top tables)

`Contact`, `Family`, `FamilyMember`, `FinancialAccount`, `Interaction`, `ProviderEvent`, `AuditLogEntry`, `RetentionPolicy`, `SafeguardingFlag`, `Booking`, `BookingSession`, `Allocation`, `RefundIntent`, `ReconciliationDiscrepancy`, `Mandate` (`GcMandate`), `Subscription` (`StripeSubscription`), `Invoice`, `Payment`, `Lead`, `Task`, `User`, `RoleAssignment`, `EncryptedField`, `PipelineStage`, `Board`, `Card`, `Label`, `CardLabel`, `Subject` (ADR 0018), `BrandingSetting` (custom logo, §4), `MailAccount` + `MailAccountMember` (Communications Hub multi-account foundation, ADR 0021), `ChatChannel`, `ChatChannelMember`, `ChatMessage`, `ChatMention`, `ChatMessageRef`, `ChatReaction`, `ChatAttachment` (internal team messaging, ADR 0022), `LeadSource` · `BrandDomainRule` · `UrlClassificationRule` · `ProductCatalogueItem` · `LeadClassificationCorrection` (lead ingestion + classification, ADR 0023), `ContactBookingProfile` · `BookingLesson` · `BookingHoursTransaction` · `BookingCreditTransaction` · `BookingSyncCursor` (booking-site student mirror, ADR 0029). Definitive shape: `prisma/schema.prisma`.

---

## 20. Auth, RBAC, and access control

**Auth.** Self-hosted Auth.js v5 (`next-auth`) backed by our Postgres handles sign in, session management, password reset, email verification, and (optional) TOTP MFA (mandatory for `ceo`, `senior_manager`, `manager`). No third-party identity processor — see ADR 0010.

**Roles.** Five canonical sales-CRM roles (ADR 0014), with friendly UI labels via `formatRoleLabel`:

| Canonical enum value | UI label | Scope |
|---|---|---|
| `ceo` | CEO | Only role that can grant or revoke `ceo` / `senior_manager`. Rotates org-wide secrets, writes tenant config. |
| `senior_manager` | Senior Manager | Everything below CEO; manages all lower roles, runs Settings, DSAR exports. |
| `manager` | Manager | Sales + finance ops: refunds, payment links, allocations, reconciliation. Invites Sales Executives and Virtual Assistants. |
| `sales_executive` | Sales Executive | Full CRUD on Contacts, Families, Tasks, Interactions. Sends payment links. CANNOT issue refunds (route to Manager+). |
| `virtual_assistant` | Virtual Assistant | Reads everything; writes notes; drafts replies. Cannot send messages, issue refunds, or change billing. |

Legacy enum values (`super_admin`, `admin`, `ops_manager`, `agent`, `finance`, `dsl`, `read_only`) remain in the Postgres `UserRole` enum per CLAUDE.md §19 forward-only rule. They are bulk-mapped to canonical roles by `20260524120100_migrate_sales_roles` (`super_admin→ceo`, `admin→senior_manager`, `ops_manager/finance/dsl→manager`, `agent→sales_executive`, `read_only→virtual_assistant`). `pickPrimaryRole` in `packages/core/auth/policies.ts` normalises any straggler legacy assignment at read time, so the system remains correct if an unmigrated row appears.

**Permission model.** RBAC with attribute checks on top.
- Roles grant action lists (e.g. `finance` can `charge.refund`).
- Attribute checks gate per-row access (e.g. only the assigned `dsl_user_id` can read `safeguarding_notes_encrypted`).
- Never check permissions in components. Check in the tRPC procedure or server action. Components trust the server.
- RSC pages must read via tRPC server-side helpers (`apps/web/lib/trpc/server.ts`) or via domain functions in `packages/core` that take a `ctx` carrying actor identity. **No direct `db.contact.findMany` calls in `app/`** — enforced by ESLint `no-restricted-imports` blocking `@studymind/db` imports under `apps/web/app/**`.

**Audit.** Every read of a minor's profile, every write to a FinancialAccount, every safeguarding read, every export, lands in `AuditLogEntry`. The log is append only and partitioned by month.

### 20.1 Permission matrix (high level)

| Action | ceo | senior_manager | manager | sales_executive | virtual_assistant |
|---|:-:|:-:|:-:|:-:|:-:|
| `contact.read` (non-minor) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `contact.read` (minor) | ✓ (audited) | ✓ (audited) | ✓ (audited) | ✓ (audited) | — |
| `contact.write` | ✓ | ✓ | ✓ | ✓ | — |
| `family.merge` | ✓ | ✓ | ✓ | — | — |
| `interaction.create` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `interaction.delete` | ✓ | ✓ | — | — | — |
| `charge.create_link` | ✓ | ✓ | ✓ | ✓ | — |
| `charge.refund` | ✓ | ✓ | ✓ | — | — |
| `subscription.cancel` | ✓ | ✓ | ✓ | — | — |
| `dsar.export` | ✓ | ✓ | — | — | — |
| `audit.read` | ✓ | ✓ | ✓ | — | — |
| `settings.write` | ✓ | ✓ | — | — | — |
| `user.invite` | ✓ | ✓ | — | — | — |
| `user.manage` | ✓ | ✓ | ✓ | — | — |
| `user.grant_manage` | ✓ | ✓ | ✓ | — | — |
| `user.deactivate` | ✓ | ✓ | — | — | — |
| `user.role.grant_senior_manager` | ✓ | — | — | — | — |
| `user.role.grant_ceo` | ✓ | — | — | — | — |
| `user.role.revoke_senior_manager` | ✓ | ✓ | — | — | — |
| `secrets.rotate` | ✓ | — | — | — | — |
| `tenant.config.write` | ✓ | — | — | — | — |

The canonical version of this table is generated from `packages/core/auth/policies.ts` so the doc and the code never drift. CI fails on mismatch (`pnpm policy:check`).

**User management (ADR 0021).** Account **creation** is CEO + Senior Manager only (`user.invite`; public self-service sign-up is disabled). **Editing** details, changing email, and **resetting passwords** require `user.manage` — held by role by CEO/Senior Manager/Manager, and additionally **grantable to any individual** via a `UserPermission` row (the only member of `GRANTABLE_ACTIONS`). `user.grant_manage` (CEO/Senior Manager/Manager) governs who may delegate that permission. Deactivation and role changes stay CEO + Senior Manager. A non-(CEO/Senior Manager) actor may never act on a CEO or Senior Manager account. New accounts and admin resets issue a **temporary password** (forced reset on first login via `mustResetPassword`) delivered in a branded welcome email plus a credentials PDF (templates + PDF in `packages/core/src/email/`, sent via Gmail (Google OAuth) through `sendSystemEmail` — never Resend). An admin password reset can either **generate** a temporary password or **set a specific one** (for when the user has lost access to their email), and may optionally skip the forced first-login change (`resetPassword` `{ password?, requireChange }`).

---

## 21. GDPR, retention, and DSAR

This is not optional. Treat every line as a hard requirement.

- **Data minimisation.** If a webhook payload includes a field we do not use, drop it before persisting to normalised tables. Raw payload still goes to `ProviderEvent` for replay; normalised tables only get used fields.
- **Field level encryption.** Sensitive at-rest data — Gmail OAuth refresh tokens, Trengo per-agent tokens, and any future field needing crypto-shred on erasure. Envelope encryption with AWS KMS. Decryption requires the caller to supply an audited purpose captured at read time. Originally built for safeguarding notes; the safeguarding workflow itself was removed in ADR 0013, but the primitives are general-purpose and retained.
- **Retention.**
  - Call recordings: 90 days default, configurable per LA contract.
  - Call transcripts: 12 months.
  - Emails: 7 years (HMRC).
  - General notes: 7 years.
  - Safeguarding notes: per LA contract (default 25 years from DOB).
  - Audit log: 7 years.
  - Marketing leads that did not convert: 12 months from last touch.
- **DSAR.** `/api/internal/dsar/<contactId>` accessible to `admin` only, generates a zip containing every row mentioning the contact, every email, every call recording, every transcript, every interaction, plus a JSON manifest.
- **Right to erasure.** Soft delete with 30-day grace period (so we can reverse a mistake), then hard delete. Hard delete includes file deletion in S3 and crypto shredding of any KMS keys exclusive to that contact.

Full procedure: `docs/compliance/`.

### 21.1 Encryption architecture (key hierarchy)

- **CMK** (AWS KMS Customer Master Key) per environment: `crm-prod`, `crm-staging`, `crm-dev`. Rotation: AWS-managed annual.
- **Per-tenant DEKs** are not used today (we are single-tenant). Per-contact DEKs are used for high-sensitivity contacts (DSL-flagged), so crypto-shred on erasure is real.
- **Envelope encryption.** Each `EncryptedField` row holds `ciphertext`, `iv`, `dek_ciphertext` (DEK encrypted under CMK), `aad` (associated data binding the field to its row id and column name), and `key_version`.
- **Local-key fallback (self-hosted without AWS).** When `AWS_KMS_KEY_ID` is unset, the DEK is wrapped with a local AES-256 master key instead of KMS — from `CRM_LOCAL_ENCRYPTION_KEY`, else derived from `AUTH_SECRET` via HKDF. Locally-wrapped DEKs carry an 8-byte sentinel so KMS-wrapped and local-wrapped rows coexist and route correctly on decrypt; fails closed if no key source exists. KMS stays the preferred backend whenever it is configured. Implementation: `packages/core/safeguarding/envelope.ts`.
- **Decryption** is centralised in `packages/core/safeguarding/decrypt.ts`. That function:
  1. Verifies the caller has the correct role and per-row attribute.
  2. Records an `AuditLogEntry` with `actor_id`, `purpose`, `request_id`, before any decryption.
  3. Calls KMS `Decrypt` with the AAD; mismatch fails closed.
  4. Returns the plaintext to the caller, never to logs.
- **Key access** in IAM is restricted to the `web` and `worker` Railway services and the on-call DSL break-glass role. Break-glass usage triggers a Slack alert and an audit entry.

---

## 22. Local development

```bash
# First time
pnpm install
cp .env.example .env.local      # fill in values from 1Password vault "StudyMind CRM Dev"
pnpm db:reset                   # creates local Postgres, runs migrations, seeds

# Day to day
pnpm dev                        # Next.js dev server on :3000
pnpm dev:worker                 # Inngest dev server on :8288
pnpm test                       # Vitest, runs unit + integration
pnpm test:e2e                   # Playwright, requires `pnpm dev` running
pnpm typecheck                  # tsc across all packages
pnpm lint                       # eslint + prettier check

# Database
pnpm db:migrate                 # prisma migrate dev
pnpm db:seed                    # idempotent seed
pnpm db:studio                  # Prisma Studio
pnpm db:reset                   # drop, recreate, migrate, seed

# Webhook testing
pnpm tunnel                     # ngrok forwards :3000, prints public URL
# then point Stripe / GoCardless / Aircall test webhooks at that URL
```

Required local services: Postgres 15, Redis 7. Provided via `docker-compose.yml`. Run `docker compose up -d` before `pnpm dev`.

**Local users.** `pnpm db:reset` seeds the production CEO row via `prisma/seed-super-admin.ts` (ADR 0014). The dev seed file may add additional canonical-role users (e.g. `ceo@dev.studymind`, `manager@dev.studymind`, `sales@dev.studymind`). Passwords are documented in 1Password vault `StudyMind CRM Dev`.

### 22.1 Environment matrix

| Surface | Local | Preview (PR) | Staging | Production |
|---|---|---|---|---|
| Domain | localhost:3000 | `<pr>.studymind-crm.up.railway.app` | `staging.crm.studymind.co.uk` | `crm.studymind.co.uk` |
| Database | local docker | per-PR Railway plugin | Railway staging | Railway production with PITR |
| Redis | local docker | per-PR Railway plugin | Railway staging | Railway production |
| S3 | localstack | shared `studymind-crm-preview` | `studymind-crm-staging` | `studymind-crm-prod` |
| Stripe | test mode | test mode | test mode | live mode |
| GoCardless | sandbox | sandbox | sandbox | live |
| Aircall | sandbox/dev line | sandbox | sandbox | live |
| Trengo | sandbox workspace | sandbox | sandbox | live |
| Slack | dev workspace | dev workspace | dev workspace | live |
| Asana | dev workspace | dev workspace | dev workspace | live |
| Gmail | dev account | dev account | dev account | live |
| OpenAI | shared dev key | shared dev key | shared staging key | live key with cost alerts |
| Sentry / Axiom | local emit-only | preview project | staging project | production project |
| Auth | local Postgres (NextAuth v5) | per-PR Postgres | staging Postgres | production Postgres (ADR 0010) |

PR previews are real environments — they exercise the full stack. They reset their database on every push.

---

## 23. Testing strategy

- **Unit tests** (Vitest) live alongside source as `*.test.ts`. Domain logic in `packages/core` must hit 90 percent coverage.
- **Integration tests** (Vitest, real Postgres via Testcontainers) for any function that reads or writes the DB. Live in `__tests__/integration/`.
- **Webhook contract tests** for every external service. Replay sanitised real captured payloads from `__tests__/fixtures/<service>/`. Adding a new event handler means adding a fixture.
- **E2E** (Playwright) for the critical flows only: sign in, create contact, view timeline, send Trengo reply, raise refund, complete reconciliation review.
- **AI tests:** mocked OpenAI client by default. A small `pnpm test:ai-live` suite hits the real API with cached responses and runs in CI nightly only (cost control).

CI runs typecheck, lint, unit, integration, and webhook contract tests on every PR. E2E runs on `main` and on PRs labelled `e2e`.

### 23.1 Fixtures and synthetic data

- **No real data in fixtures or seeds.** Use `@faker-js/faker` and our own `packages/core/test/factories.ts`. Names that look real but are not (e.g. `Test Family A1`, deterministic E.164 numbers in the `+44 70xx` test range).
- **Sanitisation script.** `scripts/sanitise-fixture.ts` accepts a captured webhook payload and produces a fixture with replaced PII. It runs in pre-commit; a fixture cannot land if the script flags real-looking data.
- **Determinism.** Seeds and factories accept a fixed seed so test output is reproducible. CI fails if a test relies on `Date.now()` without a clock injection.
- **Replay corpus.** A growing set of captured-then-sanitised events for every provider lives in `__tests__/fixtures/`. Each fixture has a sibling `expected.json` describing the post-state we expect. The contract test diffs against `expected.json`.

### 23.2 What we do not test

- We do not test third-party SDK internals. Mocking those is fine where it removes flakiness.
- We do not test that Postgres works. We test that our queries return what we expect.
- We do not write tests against the live Stripe or GoCardless environments. Test mode and sandbox only.

---

## 24. Deployment (Railway)

- Three Railway services in one project: `web`, `worker`, `postgres`. Plus Redis (Railway plugin) and S3 (AWS, not Railway).
- `web` runs the Next.js app. `worker` runs the Inngest serve handler.
- Branches deploy to preview environments automatically. `main` deploys to production after CI passes.
- Migrations run as a Railway pre-deploy step on `web`: `prisma migrate deploy && next start`.
- Secrets live in Railway environment variables, mirrored from 1Password. Never commit a real secret. `.env.example` is the documented contract.
- Production database is backed up nightly (Railway managed) plus a weekly logical dump to S3 (our own job).

`railway.json` and `Dockerfile` are committed at repo root.

### 24.1 Pre-deploy and post-deploy contract

Pre-deploy (blocks deploy if it fails):
1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`
4. `pnpm build` (Next.js + worker)
5. `prisma migrate deploy`

Post-deploy (does not block; surfaces on the deploy dashboard):
1. Healthcheck `GET /api/health` returns 200 with build SHA matching the deploy
2. Smoke test sends a synthetic Stripe webhook to the preview/production URL and asserts `ProviderEvent` row creation
3. Sentry release marker created for the new SHA
4. Inngest function manifest synced

### 24.2 Rollback

- **Application.** Railway one-click rollback to the previous deploy is the default; SHA pinned.
- **Database.** Forward only. A bad migration rolls back the application but the migration stays. Recovery is by writing a follow-up migration that fixes the schema. PITR is available; using it is an incident, not a normal operation.
- **External integrations.** Webhook handlers are versioned where it matters. Reverting code does not retroactively un-send messages or un-charge cards; we treat those as facts and reconcile.

---

## 25. Observability and on call

- **Errors.** Sentry. Every API route, every Inngest function, every server action wraps its body in a try and reports.
- **Logs.** Structured JSON via pino, shipped to Axiom. Never `console.log` in production code paths.
- **Traces.** OpenTelemetry. Each webhook receives a trace ID that follows the resulting Inngest job, the AI call, and the DB writes.
- **Metrics.** Webhook receive rate per provider, webhook 4xx/5xx rate, Inngest job duration, AI cost per day, reconciliation discrepancies opened per day.
- **Alerts.** PagerDuty. Critical: webhook 5xx above 1 percent for 5 minutes, Inngest backlog above 1000 jobs, any unhandled error in finance or safeguarding paths. Non-critical: AI cost forecast above budget, retention engine backlog.
- **Runbooks** for each alert in `docs/runbooks/`. Every alert links to its runbook.

### 25.1 SLOs and performance budgets

| Surface | SLO | Budget per quarter |
|---|---|---|
| Web availability | 99.9 percent | 13 m downtime |
| Web TTFB (50p) | < 200 ms in EU | — |
| Contact list cold load (90p) | < 800 ms | — |
| Webhook receive 2xx | 99.95 percent | 1.3 h error budget |
| Webhook to-DB end-to-end (90p) | < 30 s | — |
| Inngest function success | 99.5 percent | — |
| Reconciliation nightly | runs and completes by 06:00 UTC | — |
| AI mini-task latency (90p) | < 2 s | — |
| AI 4o-task latency (90p) | < 8 s | — |

Violations of an SLO open a ticket automatically. Three consecutive quarter-misses on the same SLO triggers a structural review in `docs/adr/`.

### 25.2 Severity definitions

- **Sev 1.** Production data loss, leakage of safeguarding or financial data, or full outage of the CRM. Page within 5 minutes. Incident commander assigned.
- **Sev 2.** Partial outage (one integration broken, dunning paused, etc), or wrong financial state visible to agents. Page within 15 minutes.
- **Sev 3.** Degraded experience, no data integrity risk. Next business day.
- **Sev 4.** Cosmetic, ergonomic. Backlog.

### 25.3 Incident response (skeleton)

1. **Acknowledge.** Page acked in PagerDuty within SLO.
2. **Stabilise.** Mitigation first (rollback, feature flag, traffic shed). Root cause later.
3. **Communicate.** `#crm-incidents` Slack channel updated every 30 minutes. External comms (LA contracts, parents) only with comms lead approval.
4. **Resolve.** Verify by metric, not by feeling.
5. **Postmortem.** Within 5 working days for Sev 1/2. Blameless. Action items tracked in Asana with owners.

---

## 26. Frontend architecture

**RSC by default.** Pages are React Server Components unless they need interactivity. Data fetching happens in the server component using tRPC server-side helpers; props are pre-shaped and minimal.

**Client components are leaves.** Any interactive widget (form, dropdown, popover) is a leaf marked `'use client'`. Avoid lifting interactivity into a parent unless the state is genuinely shared. Composition wins over context.

**State.**
- Server state: TanStack Query via tRPC react helpers. The query key is the tRPC procedure path plus inputs.
- URL state: nuqs or `useSearchParams` for shareable views. Filter state lives in the URL where possible.
- Local UI state: `useState` and `useReducer`. No Redux, no Zustand by default. If a feature genuinely needs cross-cutting state, propose it via ADR.
- Form state: React Hook Form with Zod resolvers. Schemas are imported from `packages/core/<domain>/types.ts`.

**Mutations.** Always go through tRPC. The mutation handler returns the new server state, which TanStack Query cache invalidates by query key. Optimistic updates are allowed for fast paths (mark task done) but never for money or safeguarding.

**Error and loading.**
- Each route segment has `error.tsx` and `loading.tsx`.
- `error.tsx` shows a friendly message with a `Retry` button and a `request_id` for support. It never renders raw error messages.
- `loading.tsx` renders skeletons sized to the eventual layout to prevent CLS.

**Data fetching shape.** Lists use server actions or RSC; details use RSC with streaming. Inline edits use mutations that return the patched object. We do not pre-fetch entire lists into the client when only a slice is visible.

**Toasts.** A single `Toaster` mounted in the root layout. `toast.error` only on user-facing actions; system errors go to Sentry, not to a toast.

**Performance budgets.** Critical pages (Inbox, Family, Finance) ship with a Lighthouse CI budget. Largest contentful paint under 2 s on a throttled fast 3G profile. Bundle size budgets per route segment, enforced in CI.

**RSC ↔ client data boundary.** Never send full domain entities to the client when a view-model would do. View-models live in `apps/web/lib/view-models/<domain>.ts` and are constructed in RSC. Tests are unit tests on the constructor.

---

## 27. API design conventions (tRPC)

**Naming.** Procedures are namespaced by domain: `contact.list`, `contact.get`, `contact.update`, `family.merge`, `finance.refund.create`, `pipeline.stages.list`, `pipeline.stages.create`, `pipeline.stages.reorder`, `pipeline.stages.archive`, `pipeline.family.move`. The verbs are `list`, `get`, `create`, `update`, `delete`, `restore`, `archive`, plus domain verbs (`merge`, `flag`, `assign`, `move`, `reorder`).

**Inputs and outputs.** Every procedure declares Zod input and output schemas. Outputs are view-models, not raw rows. The same input schema is used by the matching React Hook Form so the client and server validate the same shape.

**Errors.**
- `BAD_REQUEST` for validation failures (the Zod parse error is preserved).
- `UNAUTHORIZED` for unauthenticated callers.
- `FORBIDDEN` for authenticated callers without the right action or attribute.
- `NOT_FOUND` for missing rows the caller is allowed to see.
- `CONFLICT` for concurrent edits and uniqueness collisions.
- `TOO_MANY_REQUESTS` for rate-limited paths.
- `INTERNAL_SERVER_ERROR` is a real bug. It pages on-call. Never throw `INTERNAL_SERVER_ERROR` to mask an expected condition.

**Pagination.** Cursor-based on `(occurredAt, id)` tuples. Limit defaults to 25, max 100. Page sizes above 100 require explicit override and a reason. We never return all rows.

**Rate limits.** Sliding-window counters in Redis per `(user_id, procedure)`. Limits are domain-specific; the defaults live in `packages/core/auth/rate-limits.ts`.

**Audit context.** Every procedure receives a `ctx.audit` helper that records the action with actor, target, before/after diff, and a `request_id` from OpenTelemetry. Procedures that touch Contact, FinancialAccount, or safeguarding fields **must** call it. See Section 20.1 for the action list and `packages/audit/` for the writer. Procedures listed in 20.1 with audit requirements fail CI if `ctx.audit` is not called — enforced by a custom ESLint rule in `tools/eslint-rules/require-audit.ts`.

**Where things live.** Routers live in `apps/web/app/api/trpc/routers/<domain>.ts`. Register new routers in `apps/web/app/api/trpc/root.ts`. Procedures use the `protectedProcedure` builder from `apps/web/lib/trpc/builders.ts`, which injects `ctx.audit`, `ctx.user`, and the rate-limit middleware.

---

## 28. Accessibility (WCAG 2.2 AA)

The CRM is a workplace tool used at speed by a small set of people. That makes accessibility easier to ignore — and easier to break. We do not.

**Targets.**
- WCAG 2.2 AA across all primary surfaces.
- Keyboard reachability for every action a mouse can do.
- Visible focus rings everywhere; never `outline: none` without a replacement focus ring.
- Colour contrast 4.5:1 for body text, 3:1 for large text, against the actual background (not the token).

**Patterns.**
- Use Radix primitives for dialogs, popovers, menus, and listboxes. Do not roll our own.
- Form labels are real `<label>` elements, associated by `htmlFor`.
- Errors are announced via `aria-live="polite"` on the form region; do not rely on colour alone.
- Modals trap focus and restore it on close. Esc closes.
- Skip-to-content link at the top of every page.
- Tables that look like tables are tables (`<table>`, `<th scope=...>`).

**Testing.**
- `@axe-core/playwright` runs on the critical pages in CI. Any violation fails the build.
- Manual keyboard sweep is part of the PR template for any UI change above the trivial line.
- Screen reader smoke check on Sev-1 paths once per quarter using VoiceOver and NVDA.

**Reduced motion.** Honour `prefers-reduced-motion`. Animations exceeding 200 ms are gated.

---

## 29. Internationalisation

**Today.** UK English, GBP, Europe/London. The product UI and outbound family comms are British English, including "favour", "organise", "behaviour".

**Money.** Stored as `*_minor` integer pence. Formatted in the UI with `Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })`. We do not display fractional pence to agents.

**Dates and times.** Stored UTC. Displayed in the user's timezone (default `Europe/London`) via `Intl.DateTimeFormat`. Calls show local time and original timezone if the contact was abroad.

**Phone numbers.** Stored E.164. Displayed in national format for UK numbers; international format otherwise. We never strip the leading zero from a UK display.

**Tomorrow.** When we onboard non-UK partners we will introduce `next-intl` with namespace files per surface. Until then, no `t('key')` calls — strings are inline so we keep the migration cost on the right side of the move.

---

## 30. Code style and conventions

- **Imports** are sorted: built-ins, third-party, `@studymind/*` packages, relative paths. Enforced by `eslint-plugin-simple-import-sort`.
- **No default exports** for modules with more than one export. Named exports keep refactors safe. Exception: Next.js App Router segment files (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `route.ts` handlers) follow the framework's default-export convention.
- **File names** are kebab-case for files, PascalCase for React components, camelCase for utility modules (`reconcile.ts`, `Family.tsx`, `format-money.ts`).
- **Components** are colocated with their tests and styles. A folder is created when a component grows beyond a single file.
- **Hooks** start with `use`, return tuples or objects matching the convention of the dependency they wrap. Custom hooks live next to the consumer or in `apps/web/lib/hooks/` if shared.
- **Types** live alongside the function that uses them. Cross-cutting types live in `packages/core/<domain>/types.ts`.
- **Comments** are rare. We comment WHY, not WHAT. If the code is hard to read, we rewrite the code, not annotate it.
- **TODO comments** include an issue link and an owner. `// TODO(jane, #123)`.
- **Errors** are typed. `throw new BusinessError('FAMILY_HAS_OPEN_BALANCE')` is preferred over a string `Error`. The error class lives in `packages/core/errors.ts`.
- **No `any`** outside boundary files (`*.boundary.ts`) where we are explicitly converting from an external type. Lint rule enforces.
- **Logging.** Prefer `log.info({ familyId, action }, 'reconciled')` over string concatenation. Structured fields make the logs queryable.
- **Time** comes from `clock` (an injected dependency in domain code) so tests are deterministic. Never call `Date.now()` directly inside `packages/core`.

---

## 31. Feature flags and experiments

**Tool.** A small typed wrapper in `packages/core/flags/` reads from environment variables and a Postgres table that admins can edit. We do not need a third-party flag service today.

**Two kinds of flags.**
- **Release flags.** Decouple deploy from launch. Default off, code shipped behind the flag, turned on per environment when ready, removed within 30 days of full launch. Stale release flags are linted out by a CI job that reports flags older than 30 days.
- **Operational flags.** Kill switches for risky paths (e.g. `gocardless.late_failure_reversal_enabled`). These are long-lived and intentional.

**Targeting.** A flag can be on globally, on for a list of user IDs (us testing in production), or on for a fraction of Families (rollouts). Targeting is server-side; we do not leak flag state to the client beyond the surfaces it controls.

**Experiments.** When we want a real A/B test we use a separate `Experiment` row that records assignment, exposure, and outcome events. The CRM today has no public surface that warrants this; we document the path so that if we add one (e.g. variant landing pages on the booking site) we have the right shape.

**Audit.** Toggling a flag writes an `AuditLogEntry` with actor, flag, before/after, and reason.

---

## 32. Cost controls

We are a small team. Spend has to behave.

- **OpenAI.** Daily and monthly caps per task category in `packages/ai/budget.ts`. At 80 percent we page finance; at 100 percent we degrade (skip, queue, or fall back to mini). Live numbers in Axiom.
- **Aircall recordings.** S3 lifecycle: standard 0–30 d, IA 31–90 d, deletion at 91 d **unless `RetentionPolicy` for the parent contract overrides** (Section 21). Per-object tags drive the lifecycle exception.
- **Email attachments.** S3 lifecycle: standard for 90 days, then Glacier. Restore on demand from DSAR or audit triggers.
- **Aircall AI Assist.** Audited usage; we keep AI Assist on the lines where the cost is justified by call volume and outcome quality. Quarterly review.
- **Stripe.** Smart Retries reduce dunning churn; we do not pay for additional retry tooling.
- **Sentry / Axiom.** Sampling on noisy logs to keep within plan. Errors are never sampled out.
- **Railway.** Scale workers with queue depth. Web autoscales by CPU; worker autoscales by Inngest queue length.
- **Cost dashboards.** A weekly `cost-summary.md` is generated by a job and posted to `#crm-finops` with month-to-date burn and forecast.

---

## 33. Engineering rituals

- **Code review.** Every change reviewed by one engineer (two for finance, safeguarding, or migration changes). Reviewer responsibilities: correctness, audit, retention, accessibility, test coverage, doc updates.
- **Trunk-based.** Short-lived branches off `main`. Squash merge with a clean message. Conventional commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `revert`). The body explains the why.
- **Release cadence.** Continuous delivery to production from `main`. No batched releases.
- **On call.** One primary, one secondary, week-long rotation. Handover at Friday 16:00. The primary owns Sev 1 and 2 incidents; the secondary covers if the primary is unavailable.
- **Weekly review.** 30 minutes. Postmortems, dead-letter queue, reconciliation discrepancy backlog, AI cost forecast.
- **ADR.** Any non-trivial decision (new dependency, schema change with downstream impact, change to integration semantics) is recorded as an ADR before code lands.
- **Doc drift.** A change that contradicts CLAUDE.md updates CLAUDE.md in the same PR. Reviewers reject PRs that drift the doc.

---

## 34. How to work in this codebase

When asked to add a feature:

1. **Read the relevant ADR first.** If none exists and the change is non trivial, write one before coding.
2. **Find the right package.** Domain logic goes to `packages/core`. External I/O goes to `packages/integrations`. UI goes to `apps/web/components`. Shared UI goes to `packages/ui`.
3. **Schema first.** If the change touches data, update `prisma/schema.prisma`, generate, write the migration. Then write the Zod types. Then write the code.
4. **Webhook first if integrating.** Get the inbound flow working with a fixture before any UI.
5. **Audit and tests in the same PR.** No "I'll add tests later".
6. **Update CLAUDE.md if you change a rule.** This file is part of the codebase.

When asked to fix a bug:

1. Reproduce locally with a failing test.
2. Fix.
3. Confirm the test now passes and no regression elsewhere.
4. Add a runbook entry if the bug indicates an operational gap.

When asked something that touches money, safeguarding, or external mutation:

1. Slow down.
2. Confirm the user's intent in plain English before writing code.
3. Make the change reversible if possible (soft delete, draft, manual confirmation).
4. Add an audit entry.
5. Write a test that exercises the failure path, not just the happy path.

---

## 35. What NOT to do

- Do not call OpenAI directly from a React component or an API route. Always go through `packages/ai`.
- Do not put business logic in API routes or server actions. They orchestrate; the domain layer decides.
- Do not catch errors silently. If you swallow an error, you have created a future incident.
- Do not store provider raw payloads in the normalised tables. They live in `ProviderEvent`.
- Do not add a new third-party dependency without an ADR.
- Do not write SQL by hand outside migrations. Use Prisma or a typed query builder.
- Do not bypass the audit log "just this once".
- Do not rely on Zapier for anything critical. Zapier is for partner integrations and lead capture, not for our own data flow.
- Do not auto merge contacts, auto charge cards, auto delete data, or auto send messages. AI suggests, humans confirm.
- Do not put real data in fixtures or seed files. Use generated synthetic data.
- Do not introduce a BaaS (Supabase, Firebase, Hasura) for any new surface. We host frontend and backend in this Next.js app on Railway. Postgres is ours.
- Do not use floating-point money anywhere.
- Do not log decrypted safeguarding fields. Ever.
- Do not silence ESLint with broad `eslint-disable` blocks. Disable the specific rule, on the specific line, with a comment explaining why.
- Do not edit prompts in production. All prompt changes are code changes through the normal review pipeline (Section 18.3).
- Do not include unredacted minor names or full email addresses in prompts unless the task strictly requires them. Use `packages/ai/sanitise.ts`.
- Do not deploy a prompt change without passing the eval harness. CI gates this; do not bypass.

---

## 36. Glossary

- **Bacs.** UK bank-to-bank transfer system used by GoCardless Direct Debit.
- **DSL.** Designated Safeguarding Lead.
- **DSAR.** Data Subject Access Request.
- **EHCP.** Education, Health and Care Plan. Statutory document for SEND learners in England.
- **Family.** Our internal grouping of related Contacts that share a billing relationship.
- **Interaction.** Any timeline event on a Contact or Family.
- **LA.** Local Authority.
- **Mandate.** GoCardless authorisation to collect Direct Debit from a customer's bank.
- **PAYG.** Pay as you go. A booking pattern where families top up hours rather than subscribe.
- **Reconciliation triangle.** Booking hours vs Stripe vs GoCardless. The three must agree.
- **SEMH.** Social, Emotional and Mental Health needs.
- **SEND.** Special Educational Needs and Disabilities.
- **CMK / DEK.** Customer Master Key / Data Encryption Key in AWS KMS envelope encryption.
- **PITR.** Point-in-time recovery for Postgres.
- **RSC.** React Server Component.
- **SLO.** Service Level Objective.

---

## 37. Quick reference: where things live

| I want to... | Look here |
|---|---|
| Change how a Stripe webhook is handled | `packages/integrations/stripe/events/` and `packages/integrations/stripe/jobs.ts` |
| Add a field to Contact | `prisma/schema.prisma`, then `packages/core/contact/types.ts` |
| Change the timeline display | `apps/web/components/timeline/` |
| Change a per-channel customer view | `apps/web/lib/view-models/contact-channels.ts` (ADR 0017) |
| Reply to a Trengo conversation from the CRM | tRPC `interaction.trengo.reply`; resolver `resolveActiveTrengoConversation` in `packages/integrations/trengo/src/conversations.ts`; reuses `outbound.ts` `sendMessage`. Send button on `components/contact/draft-reply-panel.tsx`. Roadmap: ADR 0020. |
| Connect or manage email accounts (personal + shared team inboxes) | Settings → Email accounts (`/settings/email-accounts`). Domain `packages/core/src/mail`; tRPC `mailAccount.*` (list / get / providers / createShared / update / setDefault / disconnect / members.\* / syncFromGmail); schema `MailAccount` + `MailAccountMember` (ADR 0021). `syncFromGmail` imports the agent's existing `GmailMailbox` rows via the bridge — reuse, not rebuild. Architecture + phased plan: ADR 0021. The legacy per-agent Gmail connect stays at `/settings/mailbox`. |
| Add a new email provider (Outlook / Exchange / IMAP) | ADR 0021 Phase 7 + a new ADR for the dependency. Add the entry to the `MAIL_PROVIDERS` capability registry (`packages/core/src/mail`, flip `connectable`); implement the `MailSyncProvider` seam (`packages/core/src/mail/sync-provider.ts`) under `packages/integrations/<provider>/src/mail-provider.ts`; add a case to the dispatcher `apps/web/lib/mail/get-sync-provider.ts`. Gmail is the live reference implementation (`packages/integrations/gmail/src/mail-provider.ts`). |
| Close / reopen a Trengo conversation from the CRM | tRPC `interaction.trengo.{close,reopen}`; outbound `closeConversation` / `reopenConversation` write a `ticket_closed` / `ticket_reopened` Interaction with `payload.source = 'crm_outbound'`; the webhook job's `linkCrmOutboundEcho` (`packages/integrations/trengo/src/jobs.ts`) stamps the trengoEventId onto that row so the echo never duplicates. Per-card buttons live in `apps/web/app/(app)/contacts/[id]/sections/TrengoConversationActions.tsx`. |
| Assign a Trengo conversation to a teammate from the CRM | tRPC `interaction.trengo.assign` (Manager+); outbound `assignConversation` resolves the target's `User.trengoUserId`, calls Trengo `assignTicket`, writes a `ticket_assigned` Interaction (`source: 'crm_outbound'`) + mirrors the head. Echo folded back by `linkCrmOutboundEcho`. Assignee picker `AssignControl.tsx` on the comms-centre thread; assignable users come from `interaction.trengo.assignableUsers` (only users with a Trengo identity). Stuck assignments recovered by the `trengo/retry-pending-send` cron. |
| Add/remove a label (tag) on a Trengo conversation, or mark read | Phase 6f. tRPC `interaction.trengo.{addLabel,removeLabel,availableLabels,markRead}` (Sales Executive+ for labels; markRead any staff). Outbound `addConversationLabel`/`removeConversationLabel` resolve the label name→id via Trengo `/labels` (creating it if new — the brief's tag "Creation"), `attachLabel`/`detachLabel` on the ticket, then mirror `Conversation.tags`, write a `source: 'crm_outbound'` Interaction, and the webhook echo (incl. label-name match) is folded back by `linkCrmOutboundEcho`; stuck rows recovered by `trengo/retry-pending-send`. Client API contract pinned by `client.test.ts`. UI: `TrengoThreadActions.tsx` on the comms-centre thread (parallels `MailThreadActions` for email). |
| Add an internal (team-only) note to a conversation | Unified path `inbox.conversations.notes.{list,add}` + `ConversationNotes.tsx` (ADR 0021 Phase 6 — works for every conversation, supports @mentions + teammate notification). For Trengo tickets `notes.add` also best-effort pushes to Trengo via `pushInternalNoteToTrengo` (`packages/integrations/trengo/src/outbound.ts` → client `POST /tickets/:id/notes`), stamping `trengoSync` on the note payload. Never sent to the customer. |
| Triage the inbox | tRPC `inbox.list` takes `filter: all \| mine \| unassigned \| snoozed` and respects `inboxAssigneeId` / `inboxSnoozedUntil` on the Interaction payload. UI chips at `/inbox` (`apps/web/app/(app)/inbox/page.tsx`). |
| Add an internal note / @mention on a conversation | tRPC `inbox.conversations.notes.{list,add}` (ADR 0021 Phase 6, all staff incl. VA — §20). Stores a staff-only `note` Interaction scoped by `payload.conversationId` (never sent outbound); each `mentionUserIds` entry writes a `conversation.note_mentioned` audit row targeting that user so it lands in their notifications. UI: `ConversationNotes` (amber "Only your team sees this" panel) on the conversation thread view. |
| Read the current state of a Trengo conversation | `Conversation` table (ADR 0020 Phase 2). Upserted by the webhook job and the CRM outbound (`packages/integrations/trengo/src/conversation-head.ts`). Indexed columns: status, lastMessageAt, assigneeUserId, channel, unreadCount, tags. Message bodies stay in `Interaction` — the head is a queryable state layer, not a copy. |
| Surface an email thread in the unified inbox | `Conversation` head with `provider='email'`, keyed on `(provider, externalThreadId=gmailThreadId)`, optional `mailAccountId` (ADR 0021 Phase 3). Upserter `applyMailToConversation` (`packages/core/src/mail/conversation-head.ts`, pure + db-port, reusable by Outlook/IMAP) is called by the Gmail sync `processMessage` after writing the `email_received`/`email_sent` Interaction. Email heads list in the Comms Centre automatically; `inbox.conversations.get` joins email messages on `payload.gmailThreadId`. |
| Open the dedicated email workspace | `/mail` (ADR 0021 Phase 4, `apps/web/app/(app)/mail/page.tsx` shell → `MailWorkspace.tsx` client). Three-pane Superhuman-class client: account/folder rail + compose modal · thread list with debounced search + multi-select bulk actions (archive / read / trash) · reading pane with inline actions + mark-read-on-open + reply. tRPC `mail.accounts` + `mail.threads.list` (`apps/web/app/api/trpc/routers/mail.ts`, staff-gated). Live via `useConversationStream` (invalidates `mail.threads.list`). |
| Act on an email thread (mark read / archive / star / trash / label) | tRPC `mail.thread.{setRead,setArchived,setStarred,setTrashed,setLabels,labels}` (ADR 0021 Phase 5, Sales Executive+; VA read-only). Performs the action on the live mailbox via the `MailSyncProvider` seam (`getMailSyncProvider` → Gmail `users.threads.modify` / `trash`), reflects it on the Conversation head, publishes the SSE delta, audits `mail.thread_*`. Reversible (trash → Gmail Trash). UI: `MailThreadActions` bar on the conversation view (email rows only). |
| Reply to an email thread from the CRM | tRPC `mail.thread.reply` ({conversationId, body, cc?}) — reuses the Gmail `sendReply` outbound (`@studymind/integration-gmail/outbound`, idempotent on `(threadId, requestId)`), threaded against the latest inbound's `Message-ID`, sent from the account owner's mailbox; reflects the outbound on the head + audits `mail.thread_replied`. Sales Executive+. UI: `EmailReply` box on the conversation view (email rows). |
| Compose a brand-new email from the CRM | tRPC `mail.compose` ({mailAccountId, to[], cc?, subject, body}) — Gmail `sendEmail` outbound (literal subject, fresh thread, idempotent on `compose:<requestId>`), links matched Contacts, then `applyMailToConversation` creates the email head so it shows in `/mail` at once. Audits `mail.composed`. Sales Executive+; Gmail today (other providers with Phase 7). UI: `MailCompose` panel on `/mail`. |
| Backfill the Conversation head from historic Interactions | Admin trigger `admin.backfill.conversationHeads.start` (CEO + Senior Manager only) fires `migration/backfill-conversation-heads.requested`. Self-recursive Inngest function `packages/integrations/trengo/src/backfill-conversation-heads.ts` walks 1000 rows per invocation ordered by `(occurredAt, id)`, scheduling the next batch with a cursor. Idempotent — replays converge to the same state. Audit at start + completion only. |
| Live conversation updates in the UI | SSE endpoint `apps/web/app/api/realtime/conversations/route.ts` (Node.js runtime, staff-gated). Event bus `packages/core/src/realtime/bus.ts` is published to by `applyEventToConversation` on every head change. Lazy-init Redis pub/sub when `REDIS_URL` is set (`packages/core/src/realtime/redis.ts`) so multi-instance Railway deploys see each other; in-process EventEmitter otherwise. Client hook `useConversationStream` (`apps/web/lib/hooks/use-conversation-stream.ts`) invalidates the comms-centre + per-contact channel + notifications queries. |
| Aggregate Trengo tags on a contact | View-model `trengoTagsForContact` in `apps/web/lib/view-models/contact-channels.ts`; tRPC `contact.channels.trengoTags`. Reads `Conversation.tags` directly, returns the frequency-ordered unique set. Rendered as chips above the contact's Trengo section. |
| Review a contact-field edit suggested by Trengo | `/inbox/suggestions` (staff-read, Manager+ accept/reject). Schema `ContactFieldSuggestion` keyed on `(source, sourceEventId, field)` for replay-safety. Pure diff in `packages/integrations/trengo/src/contact-suggestions.ts`; webhook job writes via `persistContactSuggestions` on `contact.updated`. tRPC `contactSuggestion.{list,accept,reject}`. Accepting writes the Contact + the suggestion row in one transaction; never silent-merge (CLAUDE.md §3). |
| Persist a Trengo message attachment | Webhook job fires `trengo/download-attachments.requested` when a message carries `attachments`. Worker `packages/integrations/trengo/src/attachments.ts` fetches via `safeFetch` (host already allowlisted), uploads to S3 with SSE:KMS via `packages/integrations/trengo/src/s3.ts` under `trengo/attachments/{interactionId}/{attachmentId}/{filename}`, then writes the result list onto `Interaction.payload.attachments[]`. Idempotent on the deterministic key. 20 MB per-file ceiling. |
| Download a Trengo attachment | Internal route `apps/web/app/api/internal/trengo-attachments/[interactionId]/[attachmentId]/route.ts` (Node runtime, staff-gated, restricted-access enforced via `contact.get`). Streams the S3 object back — never redirects to a presigned URL so the audit trail stays honest. Surfaced as chips in the comms-centre thread. |
| Map a CRM user to their Trengo identity | `User.trengoUserId` (Int, nullable, unique). Stamped at token-connect from `/me`; the webhook job resolves `assignee_id` → `User.id` via this column. Comms-centre badges render the resolved CRM name. |
| Recover a stuck outbound message | Cron `trengo/retry-pending-send` (every 5 min). Walks Interactions still in `pending_send`, re-attempts via the audited outbound, caps at 5 attempts per row. TOKEN_EXPIRED rows are skipped (the rotation banner is the recovery surface). |
| Start a backfill | `packages/core/src/backfill/index.ts` (workers in `packages/integrations/<svc>/backfill.ts`) |
| Tweak an AI prompt | `packages/ai/prompts/<task>.ts` |
| Add a new background job | `packages/jobs/` |
| Change reconciliation logic | `packages/core/finance/reconcile.ts` |
| Update RBAC rules | `packages/core/auth/policies.ts` |
| Manage staff users (create / edit / reset password / delegate `user.manage`) | Settings → Users (`/settings/users`). tRPC `admin.users.*` (`apps/web/app/api/trpc/routers/admin/users.ts`); welcome email + credentials PDF in `packages/core/src/email/`; ADR 0021. Account creation is CEO + Senior Manager only; self-service sign-up is disabled. |
| Add a runbook | `docs/runbooks/` |
| Record an architecture decision | `docs/adr/` |
| Adjust a brand token | `packages/ui/tokens/` |
| Change the brand logo | Settings → Branding (`/settings/branding`); domain `packages/core/src/branding/`, stored in `BrandingSetting`, served from `/api/branding/logo` |
| Update the budget for an AI task | `packages/ai/budget.ts` |
| Add a new permission to the matrix | `packages/core/auth/policies.ts` (matrix in section 20 regenerates) |
| Add a tRPC procedure | `apps/web/app/api/trpc/routers/<domain>.ts`; register router in `root.ts` |
| Add an Inngest function | Cross-cutting → `packages/jobs/`. Integration-specific → `packages/integrations/<svc>/jobs.ts` |
| Add a webhook event handler | `packages/integrations/<svc>/events/<event-name>.ts` plus a fixture |
| Register a new event name | `packages/core/events/registry.ts` (Section 45) |
| Add a domain invariant | `packages/core/<domain>/invariants.ts` with a property-based test |
| Manage pipeline stages | `apps/web/app/(app)/pipeline/manage/page.tsx` + `ManageStagesTable.tsx` |
| Add a pipeline stage helper | `packages/core/src/pipeline/stages.ts` |
| Change how Family.stageId is written | `packages/core/src/family/pipeline.ts` (`moveFamily`) |
| Work on boards / cards / labels / subjects (ADR 0018) | `packages/core/src/board/` (domain), `apps/web/app/api/trpc/routers/board.ts` (tRPC), `apps/web/app/(app)/boards/` (UI). `/pipeline` redirects to the default board. |
| Ingest / classify web leads (Contact Form 7) — ADR 0023 | Endpoint `apps/web/app/api/leads/route.ts` + shared `apps/web/lib/leads/ingest.ts`; pure engine `packages/core/src/lead/` (normalise / classify / score / match); job `packages/jobs/src/leads/process-lead.ts` + boundary `apps/web/app/api/inngest/_boundary/process-lead.ts`; tRPC `lead.*`; UI `apps/web/app/(app)/leads/` + Settings → Integrations → Lead webhook panel. Event `lead/classify.requested`. |
| Add/edit a brand-domain or URL classification rule, or a product | Tables `BrandDomainRule` / `UrlClassificationRule` / `ProductCatalogueItem` (seeded in migration `20260603120000_add_lead_classification`). Editable in the DB today; a Settings UI is a fast follow. Brand detection resolves to a `Company`. |
| Manage lead-source API keys (Contact Form 7 sites) | Settings → Integrations → Lead webhook (`LeadIngestionPanel`, Manager+). tRPC `lead.sources.*` (list / create / rotate / archive); schema `LeadSource` (sha256 key hash + last4, optional pinned brand). Raw key shown once. |
| Card sub-tasks (Todoist-style checklist on a card) | Schema `CardSubtask` (`cardId`, `title`, `completed`, `position`). Domain `packages/core/src/board/subtasks.ts`; tRPC `card.subtasks.*` (list / add / update / delete, Sales Executive+). UI `apps/web/app/(app)/boards/[boardId]/CardSubtasks.tsx` in the card modal. Distinct from CRM `Task` + contact-synced tasks. |
| Manage a board's quick-action buttons | `/settings/board-quick-actions` (Manager+) lists boards → links to `/boards/[boardId]/settings` where the `BoardQuickAction` catalogue is edited. Firing is `card.applyQuickAction` (Sales Executive+). |
| Bulk-merge duplicate contacts | `/contacts` table → select 2+ → Merge (Manager+). tRPC `contact.bulkMerge` ({survivorId, loserIds}); first selected row is the survivor, the rest merge in via `mergeContacts` (`apps/web/lib/services/contact-merge.ts`) one at a time. |
| Manage "Forward to <team>" quick actions | `/settings/forwarding` (Manager+). Domain `packages/core/src/forwarding/`, tRPC `forwarding.*`, sender `apps/web/lib/forwarding/senders.ts` (Gmail OAuth via `sendSystemEmail`). UI lives on the contact page (`ForwardingSection`). Records `email_forwarded` Interactions; defaults seeded by migration `20260529120000_add_forwarding_rules`. |
| Group ops staff into teams (one user → many teams) | Settings → Teams (`/settings/teams`, CEO + Senior Manager). Domain `packages/core/src/team/`, tRPC `team.*`, schema `Team` + `TeamMember` (M:N junction). |
| Track B2B partnerships and schools | `/accounts` (kind tabs). tRPC `businessAccount.*` (`apps/web/app/api/trpc/routers/businessAccount.ts`); schema `BusinessAccount` (kind: `school | partnership`, status lifecycle, address, notes) + `BusinessAccountContact` (M:N to Contact, optional `role`). Manager+ for writes; all roles read. |
| Manage call summary templates (UCAT, Medical Interview, Dental Interview, …) | `/settings/call-summary-templates` (Manager+). Schema `CallSummaryTemplate` carries the prefill body + optional inline PDF; tRPC `callSummaryTemplate.*` (list / pickList / get / create / update / archive / restore / attachPdf / removePdf). PDFs served at `/api/call-summary-templates/[id]/pdf` (authenticated, inline). Contact-page `CallSummarySection` reads the live catalogue via `pickList` and surfaces "Open PDF" on the chosen template. |
| Upload an invoice file against a B2B account / Contact / Family | `<InvoicesPanel target={…}>` (`apps/web/components/invoices/InvoicesPanel.tsx`) is mounted on `/accounts/[id]`, `/contacts/[id]`, `/contacts/families/[familyId]`. Schema `UploadedInvoice` has three optional FKs with a DB check that exactly one is set; tRPC `uploadedInvoice.*` (list / create / update / archive / restore / delete). File bytes inline (8 MB cap); served at `/api/uploaded-invoices/[id]/file`. Sales Executive+ uploads / updates; Manager+ deletes; Virtual Assistant read-only. Distinct from the finance-mirrored `Invoice` table. |
| Sidebar external links (Main Portal / Invoice Site) | Configurable via `NEXT_PUBLIC_MAIN_PORTAL_URL` and `NEXT_PUBLIC_INVOICE_SITE_URL` (defaults: `portal.studymind.co.uk`, `b2b.studymind.co.uk`). Rendered as an "External" group at the bottom of `apps/web/app/(app)/sidebar-nav.tsx`. |
| Track students enrolled at a B2B account | `<AccountStudents accountId={…}>` on `/accounts/[id]`. Schema `BusinessAccountStudent` (firstName / lastName / yearGroup / programme / hoursContracted / hoursDelivered / status / subjects / notes / bookingStudentId / bookingLastSyncAt). tRPC `businessAccount.students.*` (list / create / update / archive / syncFromBooking). `syncFromBooking` fetches the student from booking.studymind.co.uk by `bookingStudentId` and writes `hoursDelivered` + `bookingLastSyncAt` (ADR 0029); it returns a `synced | skipped` status (skipped when `BOOKING_API_TOKEN` is unset, no id is set, or no match is found). |
| Country picker with flags on Contact + Account forms | `<CountrySelect>` (`apps/web/components/ui/country-select.tsx`) backed by `apps/web/components/ui/countries.ts` (all ISO 3166-1 countries, flag emojis derived from regional-indicator code points). Stored value is the English display name — same shape as existing free-text country columns, so legacy rows render cleanly. |
| Export a list to CSV | `<CsvExportButton>` (`apps/web/components/ui/csv-export-button.tsx`) + `apps/web/lib/csv.ts` (RFC 4180 escape, UTF-8 BOM so Excel auto-detects). Mounted on `/contacts`, `/accounts`, `/tasks`, and the InvoicesPanel header. List pages page through their tRPC procedure in 100-row chunks (cap 5000) so the export honours the current filter state. |
| Surface comms counts on list view-models | `packages/core/src/stats/`. `loadContactCommsCounts(db, ids[])` powers the Contacts table calls/texts/emails columns; `loadAccountStats(db, accountIds[])` rolls students / hours / paid-invoice spend / comms / last-contacted for the B2B Accounts table. Both are batched groupBy queries; safe to call once per page. |
| Click-to-call / click-to-email in list rows | `<PhoneLink>` and `<EmailLink>` in `apps/web/components/shared/channel-links.tsx`. Used by the Contacts table, Accounts table, and the board card preview. PhoneLink opens an Aircall (`tel:`) / Google Voice picker; EmailLink is a plain `mailto:`. Unlike the contact-detail CallButton these do NOT log an Interaction — they're scan-and-dial affordances. |
| Set / read the booking lifecycle for a Contact | `Contact.bookingStatus` enum (`lead | registered_no_hours | registered_with_hours`, default `lead`). Drives the Status column + filter on `/contacts`. The booking.studymind.co.uk puller (CLAUDE.md §15) is the only writer once wired; the CRM never auto-promotes a contact off `lead`. |
| Per-contact engagement metrics (hours / last lesson / spend) | `Contact.hoursBooked`, `Contact.hoursDelivered`, `Contact.lastLessonAt`, `Contact.amountSpentMinor`. Written per-contact by the booking site sync (ADR 0029) — explicitly NOT rolled up through Family (product direction, May 2026: contacts are students or parents/guardians, linked via contact relations rather than grouped into a Family). Null until first sync; the UI renders "—". |
| Mirror booking-site students / lessons / hours / credits (ADR 0029) | `packages/integrations/booking/` — `client.ts` (incremental keyset pull), `student-sync.ts` (pure map/match + db upserts), `jobs.ts` (4 crons, §17.1, no-op when `BOOKING_API_TOKEN` unset). Student → `Contact` (`bookingContactId`) + `ContactBookingProfile`; lessons → `BookingLesson` + timeline; ledgers → `BookingHoursTransaction` / `BookingCreditTransaction`; cursors in `BookingSyncCursor`. The contract the booking team builds is `docs/api/booking-pull-api.md`. |
| Schedule a call on a board card (date + time, UK) | `Card.scheduledCallAt` (UTC). UI picks/renders Europe/London via `apps/web/lib/format/london-time.ts` (`londonWallToUtc` / `utcToLondonWall` / `formatLondon` — no tz library, leans on `Intl`). Sidebar field in `CardSidebar`; chip on `BoardCard`. Distinct from `Card.dueAt` (date-only), which stays as the generic deadline. |
| Work in the internal team chat (Slack-style) | `/messages` (ADR 0022). Domain `packages/core/src/chat/` (channels, messages, mentions, reactions, refs, read-state; the client-safe body grammar is `chat/parse.ts`, imported via `@studymind/core/chat/parse`). tRPC `chat.*` (`apps/web/app/api/trpc/routers/chat.ts`). UI in `apps/web/app/(app)/messages/`. Channels (public/private), DMs, threaded replies, @mentions, emoji reactions, and inline `<~type:id>` references to Contact/Family/Card/Task. Channel admin is Manager+ and audited (`chat.channel_*`, `chat.member_*`); messages are staff↔staff and deliberately NOT written to the customer timeline or the compliance AuditLog. |

---

## 38. Onboarding checklist (first week)

Day 1
- [ ] Get added to GitHub `medic-mind/studymindcrmallin1`, Railway project, 1Password vault, Sentry, Axiom, PagerDuty, Slack channels (`#crm-eng`, `#crm-incidents`, `#crm-finops`, `#crm-alerts`).
- [ ] Clone, install, run `pnpm dev` and `pnpm dev:worker`. Sign in with the seeded NextAuth dev user (ADR 0010).
- [ ] Read CLAUDE.md fully. Skim `docs/adr/`.

Day 2
- [ ] Walk through one webhook end-to-end (Stripe `invoice.payment_failed` is a good first one). Replay the fixture, watch it land as a `ProviderEvent` and become an Interaction.
- [ ] Pair with the on-call engineer for an hour.
- [ ] Read the safeguarding section and the encryption module.

Day 3
- [ ] Pick up a `good first issue` PR. Aim to ship it the same day.
- [ ] Add a runbook entry for any oddity you hit during setup.

Day 4
- [ ] Shadow a finance reconciliation review with the finance lead.
- [ ] Review someone else's PR.

Day 5
- [ ] Submit a small ADR or doc update — anything you wished was documented when you joined.
- [ ] Confirm you can be on call. Read the on-call runbooks.

---

## 39. Document maintenance

CLAUDE.md is part of the codebase. Treat it like code.

- A PR that contradicts CLAUDE.md updates CLAUDE.md in the same PR.
- The doc is reviewed in the PR review like any other file.
- Once a quarter, the tech lead does a full pass: stale flags, expired ADRs, integrations that no longer match reality.
- Tables that mirror code (permission matrix, recurring jobs, environment matrix) are generated where possible. The build fails on drift.
- If you do not understand a rule, do not delete it. Open an issue and ask.

---

## 40. Contact

- Product owner: see `OWNERS.md`.
- Tech lead: see `OWNERS.md`.
- CEO: see `OWNERS.md`.
- Escalation for GDPR questions: DPO listed in `OWNERS.md`. Do not guess on these. Ask.

---

## 41. Domain invariants and business rules

Invariants are facts about our data that must always hold. They are testable, named, and enforced in `packages/core/<domain>/invariants.ts` with property-based tests. A violation is a Sev 2 minimum.

### 41.1 Family and Contact invariants

- A `Family` has exactly one billing `Contact` at any time. Changing it writes a `family.billing_contact_changed` Interaction.
- A student `Contact` under 18 must belong to a `Family` before any `Booking` can attach. Enforced in `core/family/rules.ts` and at the DB layer via a partial check constraint.
- A `Contact` cannot be both the billing contact and a student of the same Family.
- A `Contact` flagged `restricted_access` cannot be assigned to a non-DSL user. Assignment writes are rejected with `FORBIDDEN`.
- E.164 phone numbers are unique per `Contact` row but may legitimately repeat across a Family (shared landline). Conflicts surface as merge candidates, never as auto-merges.

### 41.2 Finance invariants

- The sum of `Allocation.amount_minor` for a `Payment` never exceeds `Payment.amount_minor`.
- A `RefundIntent` cannot exceed the net captured amount on its underlying `Charge`. Computed live, not cached.
- A `Family` in state `churned` cannot have an `active` Stripe subscription or an `active` GoCardless mandate. The nightly reconcile job raises a discrepancy if it does.
- Hours `delivered` for a `BookingSession` is monotonic. Once delivered, the only valid transition is `corrected_by` (a new session that nets the original to zero with a reason).
- A `FinancialAccount` balance is derived, never stored. If you find a `balance_minor` column anywhere, delete it.

### 41.3 Safeguarding invariants

_DEPRECATED — see ADR 0013._ The safeguarding workflow was removed; the
`SafeguardingFlag` table remains as an orphan with no active invariants.

Property-based tests live alongside each invariant. CI runs the full suite on every PR; the seed data is regenerated to attempt to violate each invariant deliberately.

---

## 42. Safeguarding workflow and DSL escalation

**Status: DEPRECATED — see ADR 0013.** The safeguarding workflow described
below is not part of the v1 sales CRM. Section content retained as
historical context for any future reinstatement.

Safeguarding is the part of the product where speed and discretion both matter. The workflow below is the contract between agents, DSLs, and the system. It is enforced in code, not by training.

### 42.1 Raising a concern

Any agent can raise a concern from a Contact, Family, or Interaction via the "Raise safeguarding concern" action. The form captures: nature of concern (free text, encrypted), source (call, message, email, third party), urgency (`routine | urgent | immediate`), and whether the concern relates to a child currently in placement.

On submit:
1. A `SafeguardingFlag` row is created at `concern_logged`.
2. An `Interaction` of type `safeguarding.concern_raised` is appended (the body is encrypted; the timeline shows a redacted summary to non-DSL users).
3. The on-duty DSL is notified via Trengo SMS and Slack DM. `immediate` urgency also pages the DSL via PagerDuty.
4. An `AuditLogEntry` records actor, target, urgency, and `request_id`.

### 42.2 DSL triage

The DSL has up to 4 hours (routine), 1 hour (urgent), or 15 minutes (immediate) to acknowledge. SLA timers run server-side and escalate to the deputy DSL on breach.

DSL actions: acknowledge, request more information from the raising agent, escalate to `restricted_access`, refer to LA children's services, refer to MASH, close as resolved with rationale. Every action is audited and timestamped.

### 42.3 Restricted access

Moving a flag to `restricted_access` immediately:
- Hides notes and the encrypted concern body from all non-DSL roles.
- Removes the Contact from AI prompt inputs across all packages.
- Forces an audit prompt ("why are you reading this?") on every subsequent read.
- Routes inbound communications to a DSL-only inbox; ops agents see a banner saying contact is restricted and cannot reply directly.

### 42.4 LA referrals

Referrals to a Local Authority are recorded as `safeguarding.la_referral` Interactions with the LA name, caseworker, reference number, and outbound channel. We do not send the referral from the CRM; we record that it happened and store the confirmation. Runbook: `docs/runbooks/safeguarding-la-referral.md`.

---

## 44. Threat model and security hardening

This section is the working threat model. It is not exhaustive; it is the list of attacks we have decided to defend against by default.

### 44.1 Adversaries we model

- **External attacker** with no credentials, attempting account takeover, webhook forgery, or scraping.
- **Compromised agent account** via phishing or stolen device.
- **Malicious insider** with legitimate role but illegitimate intent (rare, real, audit-detectable).
- **Supply chain compromise** of an npm package or a third-party SDK.
- **Provider compromise** of Stripe, GoCardless, Gmail, etc. We assume their keys can leak and design for blast-radius reduction.

### 44.2 Controls

- **Secrets.** Never in repo. Railway env vars mirror 1Password. Rotated on a schedule documented in `docs/runbooks/secret-rotation.md`. Per-agent OAuth and Trengo tokens are KMS-encrypted at rest.
- **Auth.** Self-hosted NextAuth v5 + Postgres (ADR 0010). MFA mandatory for all roles. Sessions max 12 hours; idle timeout 30 minutes. Device binding on for `admin`, `finance`, `dsl`.
- **Webhook forgery.** Signature verification on every webhook before any DB write. Timestamp window enforced where the provider gives one (Slack 5 min, Stripe tolerance default).
- **CSRF.** tRPC mutations require the NextAuth session cookie plus an `Origin` check. Webhooks are exempt and authenticated by signature instead.
- **SSRF.** Outbound HTTP from worker uses an allowlist of provider domains. Anything else fails closed.
- **Injection.** Prisma parameterised queries everywhere. No raw SQL outside migrations. Zod validates every external input.
- **Rate limiting.** Per-user tRPC limits in Redis; per-IP limits at the edge for unauthenticated routes.
- **Headers.** CSP with no `unsafe-inline`, HSTS with preload, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **Dependency hygiene.** `pnpm audit` in CI; Renovate bot for upgrades; lockfile committed and verified. Postinstall scripts are blocked by default.
- **Prompt injection.** AI inputs sourced from inbound messages or emails are passed through `packages/ai/sanitise.ts` which strips control tokens and instruction-shaped content. The system prompt explicitly tells the model to ignore instructions found in user-supplied content.

### 44.3 Detection

Sentry captures auth anomalies; Axiom holds structured access logs. A weekly job runs basic UEBA on AuditLogEntry: spikes in safeguarding reads, off-hours DSAR exports, refund clusters. Findings escalate via PagerDuty.

---

## 45. Event taxonomy

Consistent event names make logs, audits, and timelines readable six months from now. This section is the registry. New events go through code review against this schema; a CI check rejects unregistered names.

### 45.1 Naming

Events are dot-namespaced lower snake case: `<domain>.<entity>.<verb_past_tense>`. Examples: `family.state_changed`, `payment.late_failed`, `safeguarding.concern_raised`, `ai.draft_generated`.

Domains: `contact`, `family`, `interaction`, `payment`, `mandate`, `subscription`, `booking`, `safeguarding`, `audit`, `ai`, `system`.

### 45.2 Three streams, one taxonomy

The same event name appears in up to three places:

- **AuditLogEntry** for anything with compliance value (every safeguarding, finance, or contact write).
- **Interaction** for anything that should appear on a Contact or Family timeline.
- **Structured log** (Axiom) for anything operationally interesting.

A single user action may emit into all three. The shared name keeps cross-references trivial.

### 45.3 Required fields

Every emitted event carries:
- `event` — the registered name.
- `actor_id` — user id or `system:<job_name>`.
- `target` — `{ type, id }` of the primary entity.
- `request_id` — OpenTelemetry trace id.
- `occurred_at` — UTC ISO 8601.
- `prompt_version` — for `ai.*` events only.
- `provider_event_id` — for events derived from a webhook.

Optional fields are typed per event in `packages/core/events/registry.ts`. The registry is the source of truth; the doc table below regenerates from it.

### 45.4 Conventions

- Past tense always (`payment.late_failed`, not `payment.late_fail`).
- Never put PII in the event name.
- Never reuse a name with different semantics. Bump to `.v2` if semantics change; old name gets a deprecation date.
- Verb choice: `created`, `updated`, `state_changed`, `flagged`, `assigned`, `closed`, `reopened`, `merged`, `restored`, `archived`, `deleted`. Domain verbs allowed where they are clearer (`refunded`, `late_failed`, `replaced`).

---

## 46. Disaster recovery and data restoration

Backups exist; what matters is that we have rehearsed the restore. This section is the plan; the runbook in `docs/runbooks/disaster-recovery.md` is the script.

### 46.1 Recovery objectives

- **RPO.** 5 minutes for Postgres (Railway PITR). 24 hours for S3 (versioned bucket + cross-region replication for production).
- **RTO.** 2 hours for the web app. 4 hours for full integration recovery (webhooks reconnected, Inngest backfill complete, AI degraded mode disengaged).

### 46.2 Backup inventory

- **Postgres production.** Railway PITR (continuous WAL, 7-day window) plus a nightly logical dump shipped to `s3://studymind-crm-backups-prod/postgres/`. Weekly dumps are retained for 12 months; daily for 30 days.
- **S3 buckets.** Versioning on, MFA delete on for the production buckets. Cross-region replication to `eu-west-1`.
- **KMS keys.** AWS-managed, multi-region for the production CMK so a regional outage does not lock the data.
- **Auth and Inngest.** Auth is self-hosted in Postgres (ADR 0010), so it falls under the Postgres backup story. Inngest is provider-managed; we keep export scripts in `scripts/dr/` to dump function manifests weekly to S3 so we can rebuild.
- **Provider events.** `ProviderEvent` is the replay log of last resort. It is included in the Postgres backup; nothing else needs special handling for replay.

### 46.3 Restoration playbook (summary)

1. Declare a Sev 1 incident; assign incident commander.
2. Provision a fresh Railway environment from `railway.json`.
3. Restore Postgres to the target timestamp via PITR or from the logical dump if Railway is unavailable.
4. Restore S3 from the replica region if primary is unavailable. Object versions are addressable by version id.
5. Bring up `web` and `worker` pinned to the SHA that was running at the target timestamp.
6. Reconnect webhooks: Stripe, GoCardless, Aircall, Trengo, Slack, Asana, Gmail, Booking. Each provider has a script in `scripts/dr/reconnect-<provider>.ts`.
7. Replay `ProviderEvent` rows received between the RPO and the disaster moment; the replay job is idempotent.
8. Run reconciliation manually for the affected window; surface discrepancies to finance.
9. Communicate restoration to staff in `#crm-incidents`. External comms only with comms lead approval.

### 46.4 Rehearsal

Quarterly DR rehearsal restores production into a sandbox account and runs a smoke suite. The exercise is graded against RPO and RTO; misses become ADR follow-ups. The most recent rehearsal date and result live at the top of the DR runbook.

---

— end of CLAUDE.md —
