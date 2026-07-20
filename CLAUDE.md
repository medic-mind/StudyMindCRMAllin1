# CLAUDE.md — StudyMind All in One CRM

> Source of truth for Claude Code working on the StudyMind All in One CRM.
> **Read §0 first, then only the sections your task touches** — this file is a
> large reference (≈1,500 lines), not a front-to-back read. Use §37 ("where
> things live") to jump to the right section. When you change a rule, fix this
> doc in the same change (§39).

---

## 0. Read this first — the rules that actually bite

This is the high-signal core. It is deliberately short; each line points at
the section with the full story. If you only remember this section, you will
avoid almost every mistake agents make in this codebase.

### 0.1 How to work here
- **Don't read all 1,500 lines.** Read this §0, find your task in §37's table,
  then read only that section. Depth on demand beats a shallow full pass.
- **When unsure, ask — don't guess.** For subjective UI/UX/product calls
  (wording, whether a control is visible, what "done" looks like), confirm with
  the user before building. A wrong guess costs a whole round-trip.
- **Match the surrounding code.** Reuse the shared primitives; don't invent a
  one-off when one already exists (§0.4).

### 0.2 Shipping (workflow) — see §33
- **Every change lands on `main`.** Features, fixes, refactors, and
  visual/design/polish alike. Work that sits only on a `claude/*` branch is
  **not shipped**. Sessions forced onto a scratch branch finish by
  fast-forwarding `main` (`git push origin HEAD:main`).
- **The gate before any push to `main` is non-negotiable:**
  `pnpm typecheck && pnpm lint && pnpm test` — all green. CI re-runs it.
- **Fetch `origin/main` first; rebase if it moved; never force-push `main`.**
- Conventional commits. Update CLAUDE.md in the same change when a rule changes.

### 0.3 Invariants that must never break — see §2, §19, §21
- **Idempotency or it didn't happen** (§2/§7). Every webhook/job/external call
  dedupes on the provider event id.
- **Never auto-mutate** (§2/§3): no auto-merge contacts, auto-charge, auto-delete,
  or auto-send. AI suggests; a human confirms.
- **External APIs are the truth** (§4/§8): refetch Stripe/GoCardless; webhooks
  are notifications, not authoritative state.
- **Audit every sensitive write** (§20/§27): anything touching a Contact,
  FinancialAccount, or safeguarding field calls `ctx.audit` (a lint rule
  enforces it — see §0.4).
- **Money is integer pence** in `*_minor` columns — never floats (§19/§29).
- **Soft-delete** (`deletedAt`), never hard-delete outside the retention engine
  (§19). **Migrations are forward-only; fail closed on unknown enum values** (§19/§8).
- **Secrets never in the repo**; per-agent OAuth/Trengo tokens are KMS-encrypted
  (§21/§44).

### 0.4 Invisible tripwires that fail the build (this is why "correct-looking" code breaks here)
- **Strict CSP: no `unsafe-inline` for styles** (§44.2). Inline `style={{…}}`
  attributes and `<style>` blocks can be stripped at runtime — never rely on
  them for anything load-bearing (layouts, gradients, sizing). Author real CSS
  in `apps/web/app/globals.css` (or a stylesheet class) instead.
- **Design tokens are the only home for colour** (§4). Never hardcode a hex in a
  component; change `packages/ui/tokens/` and reference the token. The primary
  brand colour is **blue** (`primary-*`); `trengo`/`gmail` accents are scoped
  exceptions used only under `inbox/*` and `mail/*`.
- **ESLint runs `--max-warnings=0`** with import-boundary walls
  (`no-restricted-imports`): `packages/core` ✗→ `integrations`; `integrations`
  ✗→ `apps/web`; `apps/web/app/**` ✗→ `@studymind/db`. An unused import fails
  the build (§5/§20).
- **Custom lint + drift gates:** `require-audit`, `registered-event-names`
  (§45), `release-flag-staleness`, `prefer-card-surface` (a hand-rolled
  bordered-white panel under `apps/web/app/(app)/**` fails the build — use
  `<Card>`, §0.5), and `pnpm policy:check` (§20.1 matrix drift).
- **Never call OpenAI/AI providers directly** — always go through `packages/ai`
  (§18/§35). **No new dependencies without an ADR** (§3). **No BaaS** (§3).

### 0.5 UI / design defaults — see §4, §26, §37
- Reuse `apps/web/components/ui/` primitives: `Card`/`CardHeader`/`CardBody`,
  `Button`, `Field`, `Toolbar`, `PhoneInput`, `CountrySelect`, `CsvExportButton`.
  Don't hand-roll a bordered panel — use `<Card>` (lint-enforced by
  `studymind/prefer-card-surface`; `tools/eslint-rules/prefer-card-surface.js`).
- Lucide icons only; **no emoji in product UI, ever** (§4). Tabular numerals on
  aligned figures. Honour `prefers-reduced-motion`; visible focus rings always.
- RSC by default; interactive bits are `'use client'` leaves; check permissions
  in the tRPC procedure, never in the component (§20/§26).

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
| AI | Google Gemini (default) — 2.5 Flash for most, Pro override for drafts; OpenAI (gpt-4o / gpt-4o-mini / Whisper) as switchable fallback, **and Anthropic Claude** (Haiku/Sonnet, fetch-based, no SDK dep) as an **opt-in** provider. ADR 0028 | One provider seam in `packages/ai` (`generate` in `clients/provider.ts`); auto-select is Gemini-first then OpenAI (Claude never auto-activates), or pin via `AI_PROVIDER=gemini\|openai\|anthropic`, no call-site changes. Claude has no audio transcription → the Aircall fallback transcribe routes to Gemini/OpenAI. |
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

**Direct Debit operating system (ADR 0038).** The CRM is the single pane for GoCardless. A **complete provider mirror** — `GcCustomer` / `GcSubscription` / `GcPayment` plus a widened `GcMandate` (nullable `familyId`) — stores everything at the provider, all statuses, past (`finished`/`cancelled`) plans included, regardless of CRM links; the reconciliation-facing `Payment` table keeps its existing family-linked role. The webhook job handles the full payment/mandate/subscription lifecycle (mirror updates always; timeline Interactions only for the meaningful moments). **Linking** lives on `GcCustomer`: the import auto-links only a single unambiguous email match (§3 — never auto-merge), everything else is linked by a human in the workspace; linking propagates the Family to the customer's mandates so reconciliation picks them up. **Outbound actions** (all human-confirmed, audited, request-id idempotent, in `outbound.ts`): create/cancel/pause/resume subscription plans, collect/cancel/retry one-off payments, cancel mandates, and hosted mandate **setup links** — a raw redirect flow expires ~30 min so it is never emailed: we issue a durable `MandateSetupLink` token URL (14-day TTL, public open route `/api/gocardless/setup/[token]` mints a fresh flow per click; completion route `/api/gocardless/redirect-flow/complete`), **email it automatically** with a branded template (`packages/core/src/email/direct-debit-setup.ts`, system Gmail §14), auto-send ONE polite reminder after 3 days (`gocardless/setup-link-maintenance`, §17.1), auto-expire, and close the link the moment the mandate completes. tRPC `gocardless.setupLinks.{send,list,resend,revoke}`; outstanding links visible on the workspace Customers tab. **Payouts + activity (parity pass 2)**: a `GcPayout` mirror (+ `GcPayment.gcPayoutId`) powers the Payouts tab and per-payout drill-down (`/direct-debits/payouts/[gcPayoutId]` — the bank transfer and the customer payments inside it; webhook `payouts/paid`); the Activity tab (`gocardless.events.list`) reads the `ProviderEvent` replay log and resolves each event to a customer through the mirror — the CRM's version of the GoCardless Events screen. **Historic import**: `backfill/gocardless.requested` walks customers → mandates → subscriptions → payouts → payments by keyset cursor, self-rescheduling per page. UI: **Direct Debits is its own top-level nav section** — the workspace at `/direct-debits` (Overview master dashboard · Plans · Payments · Customers & mandates · Payouts · Activity · Issues, real sub-routes); the legacy `/finance/direct-debit` route redirects there so there is exactly one home. tRPC `gocardless.*` (reads + money writes Manager+, import CEO/Senior Manager).

**Fixtures.** Sanitised payloads in `__tests__/fixtures/gocardless/`. Include both happy path and `late_failure_settled` to keep the reversal flow honest.

---

## 10. Aircall playbook

**Subscribed events:** `call.created`, `call.ringing_on_agent`, `call.answered`, `call.hungup`, `call.ended`, `call.voicemail_left`, `call.tagged`, `call.commented`. If AI Assist is enabled on the line, also `transcription.created`.

**Transcripts.** AI Assist gives us transcripts and summaries directly. If a line does not have AI Assist, we fall back: download `recording_url` from `call.ended`, push to S3 (`aircall/recordings/{call_id}`), send to Whisper via `packages/ai/transcribe.ts`, then to gpt-4o-mini for outcome classification (voicemail vs human, sentiment, suggested follow-up). The decision tree is in `packages/integrations/aircall/jobs.ts`.

**Disabled webhooks.** Aircall disables a webhook after 10 consecutive failures. We monitor failure rate per webhook in Axiom and re-enable through the Public API if it ever flips. Runbook: `docs/runbooks/aircall-webhook-disabled.md`.

**Recordings retention.** Deleting a recording in Aircall also deletes the transcript and AI insights forever. We persist a copy in S3 first if the parent contract requires retention beyond Aircall's window. The S3 bucket has bucket-level KMS encryption and lifecycle rules per contract.

**Linking calls to Contacts.** Match by E.164 phone number. If multiple Contacts share a number (rare — happens for shared family lines), we attach the call to the Family and prompt the agent to assign (never auto-merge, §41.1). **When the number matches no Contact, we create a lightweight one** keyed on the phone, saving the caller's name + email when the provider gives them, so the call is logged against a real record from the first ring (the call-channel analogue of the web-lead auto-onboard exception, §16 — a call is a genuine human touch, not the §11 spam route). Single-match calls also backfill a blank name/email on the existing Contact (blanks only, never overwrite — §3). The shared resolver is `resolveOrCreateContactForCall` (`packages/core/src/contact/from-call.ts`), so a future Google Voice inbound pipeline reuses the exact same path. A later web lead matched on the same phone updates that Contact's remaining blank details via the lead re-enquiry path (ADR 0023).

**Analytics.** The Aircall report (`/reports/aircall`, Manager+) is decluttered into three tabs — Overview · Peak times · Performance — over a shared headline-KPI strip, with a one-click **PDF export** (`/api/reports/aircall/pdf`, rendered by the dependency-free `packages/core/src/email/pdf/pdf-writer.ts`). **Customisable peak times** are operator-defined `CallPeakWindow` rows (a recurring season month/day range — wrapping the year-end — plus weekdays + an hour band; `year` null = every year, or pinned to one). Calls are classified on the **Europe/London** clock so the heatmap, hour labels, and windows agree. Pure logic + display labels live in `packages/core/src/reports/peak-windows.ts` (unit-tested); CRUD is `reports.aircall.peakWindows.*` (Manager+); managed inline via `PeakWindowsManager.tsx`. The page is a **live client workspace** (`AircallWorkspace.tsx` driving one cached `reports.aircall.summary` query with keep-previous placeholder data): filter/tab clicks respond instantly with no full-page server round-trip, the daily trend is the hover/keyboard `InteractiveLineChart` (`apps/web/components/charts/interactive-line-chart.tsx`), and the summary fetches the current + previous period in a single DB round-trip.

**Complete mirror (all calls reflected, not just live).** Every metric is computed from our `Interaction` (type `call`) rows — we do **not** query Aircall's analytics API. Calls land three ways: live **webhooks** (`call.*` events), an on-demand **historic backfill** (`backfill/aircall.requested`), and a recurring **`aircall/sync-calls`** cron (§17.1) that REST-pulls recent calls every 10 min so nothing is lost if a webhook is missed. All three persist **matched AND unmatched** calls, and all three **create-or-match a Contact** for the counterparty via the shared `resolveOrCreateContactForCall` (§10) — an unknown E.164 number becomes a lightweight Contact (so an imported missed call is never orphaned), a known number links to its existing Contact, and a shared line (>1 match) attaches to the Family with `triageRequired`. Only a withheld/non-E.164 number keeps `contactId` null and surfaces in the missed-calls workspace by its raw number. The counterparty E.164 number is always stored at `payload.rawDigits`.

**Missed-calls workspace (`/calls`, all staff; action Sales Executive+).** A queue of inbound calls nobody answered (rang out OR voicemail), including unknown numbers. "Called back" is **derived** — a later outbound call to the same number (format-insensitive match) or to the same linked Contact (any attempt) auto-resolves the miss, so calling back from anywhere clears it with no manual step. The matched "number" is resolved by `callNumberFromPayload` (`payload.rawDigits` for Aircall calls, falling back to `payload.toNumber` for a **manually-logged click-to-call** — the contact-page Call button, and the only record for a Google Voice callback since it has no webhook); without that fallback a manual callback could only clear a miss through a shared contact link, so a callback to an unlinked or differently-linked number silently stayed Outstanding. A manual override (`actioned` / `dismissed` for spam) is the only stored state — `MissedCallReview`, keyed on the Aircall call id. Pure logic (dedupe + number/state) in `packages/core/src/calls/missed-calls.ts` (unit-tested); tRPC `calls.missed.{list,setReview,clearReview}`; UI `MissedCallsWorkspace.tsx` with click-to-call.

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

**Subscribed events.** `message.channels`, gated per channel by the bot's membership: Slack only delivers events for channels the bot has been `/invite`d to, so the invite is the consent gate — never the whole workspace. Setting `SLACK_WATCHED_CHANNELS` (comma-separated ids) narrows reading to an explicit allowlist; unset means every bot-member channel. Logic in `packages/integrations/slack/config.ts`.

**Summary parser.** A Slack message in a watched channel triggers an Inngest function that uses gpt-4o-mini to extract: candidate contact identifier (name, email, phone), summary text, sentiment, next action. The result becomes an Interaction of type `slack_summary` linked to the matched Contact **and/or B2B account** (see below).

**Threads / replies.** `conversations.history` returns only top-level messages and thread ROOTS — never the replies inside a thread. So every pull path that walks history (the 90-day backfill AND the recurring/on-demand `slack/sync-messages` pull) also walks each root's replies via `conversations.replies` (`walkThread`/`processMessageWithReplies` in `packages/integrations/slack/src/backfill.ts`, unit-tested). Each reply is matched to a customer in its own right; a reply that names no customer of its own **inherits the customer named in the thread root** (`threadParentText` — same rule the live webhook handler already applies in `jobs.ts`), for BOTH the free email/phone match and the AI context. The shared per-message processor skips `bot_id`/`app_id` posts (so the backfill never re-ingests the CRM's own `#callsummaries` announcement as a duplicate `slack_summary`) and stays idempotent on `(channelId, ts)`, so re-runs converge. Going forward, a new reply also arrives as a live `message` event (thread-aware since it carries `thread_ts`).

**Confidence threshold + matching.** Above-0.5-confidence extractions (ADR 0034 amendment — the matcher's unambiguous rule is the real safety, not the AI's self-confidence) resolve through one shared resolver (`resolveSlackLinkTarget`, unit-tested) that files the mention in the **correct place** for BOTH sides of the CRM:

- **Deterministic-first, AI as backstop.** Every ingest path tries the FREE route before any AI spend (§32): a verbatim **email/phone** in the text (or its thread root), then **name candidates extracted deterministically** from the text (`extractNameCandidates` — proper-noun runs, sentence-opener + stop-word guarded, unit-tested) resolved via `resolveSlackLinkTargetFromNames` (each candidate through the unambiguous-only matcher; two candidates resolving to two different people = park, a person + their own school = the contact). So name-only mentions ("Spoke to Aanya Sharma about the mocks") link **without any AI provider configured**; the AI extractor remains the backstop for prose the rules can't read. The noise gate exempts bare name-shaped messages ("Sampada" as a terse thread header) so they flow to the matcher/tray instead of being dropped. If `groups:read` is missing, private channels are excluded from listing/ingestion — the client now logs a structured warning instead of failing silently (re-install the app with `groups:read` + `groups:history`).
- **Customer (Contact).** Resolve to a contact by **email → phone (E.164-normalised variants + unique 9-digit suffix) → name** (`matchContactByCandidate`). The name pass auto-links an unambiguous **first + last** name AND an unambiguous **single token / surname / whole-name-in-one-column** (so "spoke to Aanya" resolves), matching exactly ONE contact. When that contact belongs to a B2B account (`BusinessAccountContact`), the Interaction is **also** stamped with `businessAccountId` so it shows on the school/partner Activity timeline too — same convention as synced email (§14 B2B-account stamping).
- **School / B2B partner (BusinessAccount).** When no person matches, the message is resolved against the account directly by **org email → email domain (skipping free webmail) → phone → org name** (`matchBusinessAccountByCandidate`), so a note about a school with no known contact still lands on that school's timeline rather than vanishing into the tray. Unambiguous-only, same as contacts.

Both matchers also run an **opt-in fuzzy pass** (Slack only, behind the unambiguous-only guard): contacts match a **nickname** (`Jon`↔`Jonathan`, curated map in `packages/core/src/contact/nicknames.ts`) or a length-guarded **first-name prefix**; accounts match a **partial org name** (`Oakwood`→`Oakwood Primary School`). Fuzzy links are stamped `matchFuzzy:true` on the record so they stay auditable. Exact matching stays the default for every non-Slack caller (§3).

Anything below threshold, name-ambiguous (two Jane Smiths), or unmatched lands in the "unassigned summaries" tray — **on EVERY ingestion path: the live webhook, the 90-day backfill, AND the recurring/on-demand pull** (they share `processSlackMessage`, which parks any non-noise message it cannot resolve rather than dropping it). This is the fix for "Slack history never showed up": the historic import and the pull used to **silently drop** every message that wasn't an immediate email/phone/AI match — a customer not yet in the CRM, a name-only mention when no AI key is configured, or a first name two customers share — leaving no Interaction, no tray row, and no error. Now those all park and are visible. The tray is no longer a dead-end either: the recurring **`slack/relink-unassigned`** job (§17.1) re-runs the resolver over every parked row for free and auto-links the unambiguous ones (draining the backlog + self-healing when a contact/account is created after the mention), and staff can force it immediately with the tray's **"Re-run matching now"** button (`slackSummary.unassigned.relinkNow` → `slack/relink-now.requested`, Manager+). The noise filter (acks/emoji/bare links) is the volume control — those are still skipped, never parked. Never auto-attach on ambiguity, never auto-create a contact or account (§3).

**Call-log auto-onboarding + own-brand guard + join-all (ADR 0043).** A Slack message whose OWN text carries a diallable phone that matches no contact **auto-creates the customer** via the shared call resolver (`resolveOrCreateContactForCall`, §10 — fill-blanks on a single match, park on shared lines, never merge §41.1), on every ingest path incl. the relink cron (so the parked backlog drains into real records). The phone is the gate — name-only chatter still never creates anyone (§11's spam guard stands). Name = the call-log header (text before the number, handles lower-case names) else the first non-brand candidate; `normaliseSlackPhoneToE164` fixes the team's "+44 07818…" paste. **Own-brand names/domains** (live `Company` + `BrandDomainRule` catalogues + seeds, `own-brands.ts`, cached) are filtered from name/email candidates on every path so "Medic Mind" can never hijack a match or become a contact. **"Join all public channels"** (Settings → Integrations → Slack, CEO/SM, audited `slack.channels_joined`) `conversations.join`s every public channel via the `channels:join` scope — the operator-confirmed bulk form of the §12 invite consent; private channels still need `/invite`. The 90-day import runs one Inngest step per page (per-message steps exceeded Inngest's step budget and killed large imports) with delta progress every 10 messages.

**Channel-aware ingestion rules (ADR 0042).** The team's Slack layout encodes intent in the channel NAME, and the ingest honours it: a contact-linked mention from a channel whose name contains `complaint` (e.g. `#complaintcallsummaries`, `#b2bcomplaints`) **also auto-opens a Complaint** on the existing Complaints queue — open/medium, system-authored (`createdById` null), title = the summary's first line, category mapped from the AI category where it fits the presets, with the same timeline note + `complaint.created` audit as the human log flow. Idempotent on `Complaint.sourceKey` (`slack:<channelId>:<ts>`), applied on **every** ingestion path (live webhook, recurring pull, backfill, relink), and gated to messages ≤7 days old so a deep backfill never floods the Active queue with history. The mention's own category chip is stamped `complaint` in those channels. Pure rules in `packages/integrations/slack/src/channel-rules.ts`; executor `complaints.ts` (best-effort — a complaint failure never blocks the archive).

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
(4) `/mail` client — *v1 + compose/reply/search/bulk/preview/shortcuts +
Starred/Archived/Trash folders + **rich-HTML reading pane** (ADR 0041)
implemented* (HTML compose still to come); (5) two-way action sync (read/archive/star/label/delete) — *implemented
both directions*: outbound CRM→Gmail, **plus inbound Gmail→CRM flag mirroring**
(`mirrorThreadFlags` — the history sync now pulls labelAdded/labelRemoved/
messageDeleted and re-reads each thread's Gmail label state via
`GmailClient.getThreadState`, converging read/star/archive/trash onto the
`Conversation` head; `isStarred`/`isTrashed`/`flagsSyncedAt` columns). Drafts
sync still to come; (6) shared-inbox operations — *implemented*
(assign already existed; + notes/@mentions + one-click task-from-conversation);
(7) Outlook/Exchange/IMAP providers — design in **ADR 0024** (deps not added
until approved); (8) templates, automations, analytics, calendar, unified
channels.

### Gmail provider specifics (live today)

**Auth.** OAuth 2.0 per agent. Refresh tokens encrypted with KMS, never logged. Granular scopes only — `gmail.readonly`, `gmail.send`, `gmail.modify` (no full account access). **Multi-account: each connected mailbox stores its OWN refresh token** (`GmailMailbox.refreshTokenCipherId`), so several inboxes connected under one login (info@brandA, info@brandB, …) all sync independently. The single `User.gmailRefreshTokenCipherId` is kept only as the default-mailbox fallback (system send / outbound). The live sync, refresh-watch and backfill all act as a specific mailbox via `createClientForAgent({ address })`; the OAuth callback encrypts the token keyed on `${userId}:${address}` (possible because the `EncryptedField→Contact` FK was dropped, ADR 0012 follow-up). Mailboxes connected before this must reconnect once to store their own token.

**Real-time push.** Google Cloud Pub/Sub `watch` for real-time delivery. Watch expires after 7 days, so we renew every 6 days via the `gmail/refresh-watch` job.

**Sync surface today.** Read sync, reply from CRM, sent items reflect in Gmail, attachments, 90-day backfill. **Read/star/archive/trash mirror both ways** (ADR 0021 Phase 5): a change made in the Gmail UI flows back to the CRM via `mirrorThreadFlags` in the history job, and CRM actions push to Gmail. The OAuth refresh client reads `GOOGLE_OAUTH_CLIENT_ID/SECRET` (falling back to legacy `GOOGLE_CLIENT_ID/SECRET`) — the SAME client the connect flow uses, so background refresh never breaks with `invalid_client`.

**Label-mirror — /mail folders == Gmail's own views (ADR 0021 Phase 5).** The CRM no longer re-derives folder membership from the lossy `Conversation.status` enum. Every sync path (live `processMessage`, backfill, the history `mirrorThreadFlags`, the on-demand resync, and the `gmail/sync` poll) writes the thread's FULL current Gmail label-id set to `Conversation.gmailLabelIds` — system labels (INBOX, SENT, SPAM, IMPORTANT, STARRED, UNREAD, SNOOZED), Gmail's category tabs (`CATEGORY_PERSONAL/SOCIAL/PROMOTIONS/UPDATES/FORUMS`) and custom label ids. `/mail` then derives Inbox + the **Primary/Social/Promotions/Updates/Forums tabs**, Starred, Snoozed, Important, Sent, Spam, All Mail, Archived and Trash from that set with the SAME predicates Gmail uses (pure `gmail-folders.ts`: `gmailFolderMatches` / `buildGmailFolderWhere`, unit-tested) — so the CRM mirrors Gmail's inbox/tab/spam/important state exactly, including a thread Gmail removed from the Inbox or sorted into Promotions. Live first-sync converges the **thread union** via `getThreadState` (so a sent-only or archived-in-Gmail thread lands in the right folder, not the Inbox). The CRM-side actions (archive/star/trash/read/label) patch `gmailLabelIds` optimistically (`mutateLabelSet`) so a thread moves folder the instant you act. Heads synced before this field exists fall back to the old `status`/`isStarred`/`isTrashed` columns until the `gmail/sync` resync-heal converges them — no manual "Resync" needed. Custom-label **chips** still live on `Conversation.tags` (the human-readable names); drafts/snooze two-way mirroring still to come.

**Threading.** Use Gmail's `thread_id` directly. Do not invent our own threading.

**Contact matching.** Match by `from`, `to`, `cc`, `bcc` addresses. Many to many — one email touches several Contacts. Persist all links so each Contact's timeline shows the full thread regardless of which address was matched. Unmatched mail must **never** auto-create a Contact (§11 rule, applied to email — create a `Lead` instead).

**Attachments.** Stream to S3 on first sync; do not store payloads in Postgres. Reference by S3 key in `Interaction.payload`.

**Google Voice ride-along (ADR 0032).** Google Voice has no call/SMS API, so we ingest its `voice-noreply@google.com` notification emails through this same Gmail sync: when the `google_voice.email_ingest_enabled` flag is on, `processMessage` hands those messages to the Google Voice handler instead of the normal email path. It logs a `call`/`message` Interaction (`source:'google_voice'`, voicemail + missed call flagged `needsManualReview`), reuses `resolveOrCreateContactForCall` to match/create the contact, and posts a best-effort team Slack alert. Voicemail audio streams to S3 like any attachment. This channel needs manual work by design (an agent types up the summary / checks the missed call). Live-call fidelity requires porting the number to a real telephony API (Twilio/Aircall).

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

**Auto-onboarding + dedupe (overrides §11 for web leads; FULLY automatic since ADR 0044).** First enquiry auto-creates a Contact (brand-tagged) + a card on the default board's "New leads" stage. A re-enquiry matched by email/phone never creates a duplicate Contact — it annotates the existing contact and adds a fresh card only if >24h since the last enquiry (within 24h is one card, anti-spam). **Nothing parks for a human**: a shared email/phone attaches to the most recently active matching contact (stamped `ambiguousResolved` on the Interaction + audit — an annotation, never a merge §41.1); a name-only submission onboards (or attaches on a unique exact-name match; two same-named contacts create a fresh one rather than guess); a submission with no name, email or phone is auto-dismissed as junk (audited). The `lead/reprocess-unresolved` cron (30 min) re-runs legacy `needs_triage` rows + lost `received` rows so the pipeline is zero-touch and self-healing. `/leads` is the **Web enquiries log** (plain-English outcomes; "Needs attention" view only while legacy rows remain).

**Enquiry history + IP country + composed phone.** Every enquiry (first + each re-enquiry) is a `lead_enquiry` Interaction surfaced as an **Enquiries** section on the contact page (site, form, subject, products, preferred time, message, IP) via `lead.enquiriesForContact`; a re-enquiry also prepends a one-line "[date] Enquired again: …" summary to the contact's pinned note and upserts the latest subject onto `ContactSubject`, so the contact + new card always reflect the **latest** enquiry. The client **IP** is captured at `/api/leads` (`Lead.ip`); when the form has no country field, the classify job geo-locates it (best-effort `ipwho.is`, falling back to `ipapi.co`, both via `safeFetch`, injected at the worker boundary) → `Lead.countryCode`. The country (form field first, then IP) drives **phone composition**: a nationally-typed number ("928 812 118" + Peru) becomes full E.164 via `findDialCountry`/`composePhoneE164` (`packages/core/src/lead/dial-codes.ts` — the **full ISO 3166-1 dial-code set**; a missing country there is a bug, not a gap to tolerate). **A typed number always lands on the contact's phone field:** when no country resolves, `inferPhoneE164` recognises a dial code typed without the `+` ("51 928 812 118"; strict 11–15-digit guard so a national number is never misread as international), and if even that fails `asTypedPhoneFallback` stores the digits as typed — visible and manually dialable — instead of burying them in notes. "Phone (as typed)" in notes now only fires for values too short to be a number at all. `Contact.country` is also set from the same resolution.

**Card organisation (site / form / subject / time / board).** Each onboarded card is organised, not just dumped: the detected **Subject** becomes a `Subject` tag on the card (find-or-create, so the board groups by topic); the **site** (`LeadSource.name`) + **form title** are written to `Contact.referralSource` ("Web enquiry · Medic Mind site") and the card/contact notes, and surface as Site/Form/Subject/Board columns in the Leads tray; a **date/time** the enquirer picks on the form (a `[date]`/`[time]`/`datetime` field, a "preferred call time", or a phrase in the message) is parsed (Europe/London → UTC, `londonWallToUtc` in `packages/core/src/lead/`) and set as the card's **Scheduled-call** chip automatically — with an **AI fallback** (`preferredCallTime` on the `lead_classification` mini-task, grounded on the current London date so "Thursday at 3" resolves correctly; shape-validated, deterministic parser always wins) for times the rules can't read. The **card face** shows NAME → email → phone → SUBJECT + COMPANY (the contact's first brand tag, a `company` `CardFaceKey`) + **enquiry-type chips** (`enquiryType` key — the lead-classification categories "Tutoring" / "Summer Camp" / "Online Courses" / "UCAT" via `loadContactEnquiryTypes`, latest-first) → scheduled call → the quick-action buttons. **Free-resources routing:** enquiries from download/freebie/guide forms route to a separate **Free Resources** board (`board_seed_free_resources`) instead of the Sales Pipeline — driven by configurable `UrlClassificationRule`s whose category is `Free Resources` (plus a slug heuristic), so ops add more without a developer. The classifier returns `subject` + `destination` (`sales` | `free_resources`) on `LeadClassification`; the board falls back to Sales if Free Resources isn't seeded.

**Legacy Zapier endpoint.** `/api/webhooks/lead` (+`/v2`) is the older stable, versioned bearer-token endpoint with a fixed JSON schema (`docs/api/lead-webhook.md`). Additive only; bump to `/v2` for breaking changes; old endpoint stays alive 12 months. It remains for existing Zaps; new integrations use `/api/leads`.

**Trust.** Zapier is fine for partner integrations and lead capture. It is **not** the source of truth for anything financial, safeguarding, or operational. Anything critical lives in a first-party integration with full audit and contract tests.

**Medi Platform account sync (ADR 0037).** The Medic Mind **UCAT portal** ("Medi Platform") POSTs `user.registered` to `POST /api/contacts` whenever someone creates an account. Unlike `/api/leads`, this **onboards a Contact but never creates a board card or pipeline stage** — a signup is a record, not a sales lead. The thin handler (`apps/web/app/api/contacts/route.ts`, bearer auth via `MEDI_SYNC_TOKEN` → `LEAD_WEBHOOK_*` fallback, fail-closed §8) persists raw → `ProviderEvent` (`provider='medi'`, idempotent on `<event>:<mediUserId>`) and enqueues `medi/account.received`. The worker (`packages/jobs/src/medi/process-account.ts`) resolves/creates the Contact via `resolveOrCreateContactForMediAccount` (`packages/core/src/contact/from-medi.ts` — email-then-phone match, backfill blanks, never auto-merge §41.1), adds a `note` Interaction ("Imported from the Medi Platform"), optionally links a named parent/student (`ContactLink`), and audits `medi.account_synced`. Because the contact is stored under the same lowercased-email / E.164-phone keys the lead funnel (§16) and call resolver (§10) match on, a later enquiry/missed call **annotates the same contact instead of duplicating it** — and vice-versa. Pure logic in `packages/core/src/medi/` (normalise + match, unit-tested).

---

## 17. Background jobs (Inngest)

Every async unit of work is an Inngest function. Conventions:

- Function ID is `<domain>/<action>` (e.g. `finance/reconcile-family`, `ai/classify-call-outcome`).
- Use `step.run` for each external call so retries are granular.
- Use `step.sleep` for delays, never `setTimeout`.
- Concurrency limits per function. Default `{ limit: 5 }` (Inngest plan caps per-function concurrency at 5; bump back up if the plan is upgraded). AI heavy: `{ limit: 3 }` to respect rate limits.
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
| `users/login-reminders` | daily 09:00 UTC | Email staff who were given a CRM account but have never signed in — one gentle nudge every few days, capped (`shouldRemindLogin`, `packages/core/src/auth/login-reminders.ts`; user-management upgrade). No-op without a system mailbox; disable with `USER_LOGIN_REMINDERS=off`. Also manual per-row via `admin.users.sendLoginReminder`. |
| `gmail/sync` | every 10 min | **Push-independent safety net** (mirrors `trengo/reconcile-status` + `aircall/sync-calls`). Pulls every connected mailbox forward from its `historyId` (new mail + Gmail-side read/star/archive/trash/label changes) AND heals a bounded round-robin batch of the least-recently-synced email heads onto Gmail's CURRENT thread state — so "open Gmail == open the CRM" holds even when Pub/Sub push isn't delivering (the common self-hosted case). Shares the engine `syncMailboxHistory` with the push handler; the heal converges legacy heads' flags + full `gmailLabelIds` set with no manual "Resync". No-op without connected mailboxes; invalid-grant marks the mailbox `needs_reconnect`. Also on-demand: `gmail/sync-now.requested` (the **Sync from Gmail** button on `/mail`, Sales Executive+ → `mail.syncNow`). The tick also **auto-deepens the mirror**: it keeps extending each agent's imported history backwards in 90-day chunks (progress tracked via completed `BackfillJob` rows, one in-flight chunk per agent) until `GMAIL_MIRROR_HORIZON_DAYS` (default 10 years), so the whole mailbox reaches the customer timelines + `/mail` with no manual "Import history". |
| `booking/sync-students` | every 5 min | Pull changed students from booking.studymind.co.uk → Contacts (ADR 0029) |
| `booking/sync-lessons` | every 5 min | Pull changed lessons → `BookingLesson` + timeline Interactions |
| `booking/sync-balance-ledger` | every 15 min | Pull the hours-balance ledger → `BookingHoursTransaction` |
| `booking/sync-credit-ledger` | every 15 min | Pull the credit ledger → `BookingCreditTransaction` |
| `ai/regenerate-status-summaries` | every 30 min for changed contacts | Refresh the 2 sentence "Current Status" header |
| `aircall/recover-disabled-webhook` | hourly | Re-enable Aircall webhook if it was disabled by failures |
| `aircall/sync-calls` | every 10 min | Pull recent Aircall calls (matched + unmatched) via REST so the call mirror stays complete even if a webhook is missed. No-op without `AIRCALL_API_*`. Cursor = newest stored call − **24h** overlap (no cursor table) so a missed/late webhook self-heals within a day; cold-start reaches back `AIRCALL_SYNC_LOOKBACK_DAYS` (default 30) then moves forward. Also **on-demand**: the `aircall/sync-now.requested` event (a "Sync from Aircall" button on `/calls`, Sales Executive+) fires the same pull for an immediate force-sync |
| `backfill/reap-stale` | every 10 min | Fail any `BackfillJob` stuck `pending`/`running` with no progress past `STALE_BACKFILL_MS` (15 min) via `reapStaleBackfills`. An abandoned import (worker redeployed mid-run, or Inngest never picked it up) self-heals instead of showing a permanent "Importing 0 items…" banner. Complements `startBackfill`'s supersede-on-retry and the `admin.backfill.mine` banner query's own staleness filter (ADR 0017) |
| `lead/reprocess-unresolved` | every 30 min | Re-run classification over legacy `needs_triage` rows and `received` rows whose classify event was lost (ADR 0044). With the fully-automatic router nothing re-parks, so the historic tray backlog drains itself. Batch 200/tick. |
| `gocardless/reconcile-late-failures` | every 4 hours | Walk recent confirmations and surface any new late failures |
| `gocardless/relink-customers` | every 6 hours | Re-attempt the unambiguous email/phone link for GoCardless customers imported before their CRM contact existed (`linkUnlinkedGcCustomers`, ADR 0038) so their Direct Debit data reaches the contact panel without a re-import. Unambiguous-only, never auto-merge (§3/§41.1). |
| `slack/sync-messages` | every 15 min | **Pull** recent messages from EVERY channel the bot is a member of (auto-discovered via `conversations.list` → `isMember`, or the `SLACK_WATCHED_CHANNELS` allowlist when set) and process each via the shared backfill processor — so ingestion does NOT depend on the Events-API webhook being configured. No-op without `SLACK_BOT_TOKEN`. Overlap window `SLACK_SYNC_LOOKBACK_MINUTES` (default 120 — overlap costs only DB dedupe checks, never AI re-spend). **Channel walks are isolated**: one failing channel (rate limit, revoked access) is recorded in the run result (`failedChannels`) and the rest of the tick still runs — previously a single throw aborted every later-alphabet channel, the root cause of "randomly missing" messages. Slack 429s retry honouring `Retry-After` (bounded, `slackApiGet` in the backfill module). Each tick also runs an **old-thread scan** (`SLACK_SYNC_THREAD_SCAN_DAYS`, default 7): thread ROOTS older than the window whose `latest_reply` falls inside it get just their new replies walked — `conversations.history` only returns roots, so those replies were structurally invisible to a webhook-less pull. Also **on-demand**: `slack/sync-now.requested` (the "Sync from Slack now" button on `/inbox/slack-mentions`, Manager+) pulls with a wider look-back. The historic bulk pull is still the admin "Import history" backfill — which now also auto-discovers all member channels (it previously enumerated ZERO channels when no allowlist was set, so nothing was ever pulled). Both pull paths also walk each thread's **replies** (`conversations.replies`), since history omits them (§12 Threads/replies). |
| `slack/relink-unassigned` | every 30 min | Re-run the shared resolver (`resolveSlackLinkTarget` — Contact else B2B account, §12) over every open `UnassignedSummary` and auto-link the unambiguous ones as a `slack_summary` (ADR 0034 amendment). FREE — reuses the AI extraction already stored on the row + a deterministic email/phone text scan **+ a deterministic name-candidate re-scan of the archived message text** (`extractNameCandidates` → `resolveSlackLinkTargetFromNames`, so rows parked with `name:null` before name extraction existed still self-heal), never calls the AI again. **Also retro-stamps** existing contact-linked mentions with their contact's school (`businessAccountId`) so historic mentions surface on the school timeline too (walks the small `BusinessAccountContact` set, fill-blanks `updateMany`, idempotent). Drains the parked backlog and self-heals (a mention parked before its contact/account existed links once it appears). Ambiguous rows stay in the `/inbox/slack-mentions` tray (§3). |
| `trengo/reconcile-status` | every 10 min | Re-fetch each Conversation's CURRENT state from Trengo (oldest-checked-first, 120/tick) and re-converge the head — status (open/closed/**spam**), assignee, labels, and the specific **channel** ("business number") — through the same monotonic merger the webhook uses. The safety net so a dropped or unsubscribed lifecycle webhook ("closed on Trengo, still open here") self-heals instead of drifting permanently (golden rule #4). Staff can also force an immediate convergence of the recent open set with **`trengo/reconcile-now`** (the "Sync from Trengo" button on the inbox). No-op without a connected token. A ticket **deleted in Trengo** (a 404 on the pinned endpoint) is converged **out of the active inbox** — its head moves to `archived` (hidden from every active folder, but never hard-deleted — §3 — so it stays recoverable + auditable), so "hidden on Trengo, still showing here" self-heals; an unparsable (non-404) response still leaves the head untouched. Status flips audit `trengo.status_reconciled` (deleted carries `reason:'deleted_in_trengo'`). Each tick is also the **full-mirror engine**: a newest-end discovery scan imports tickets we have never seen (any age) + refreshes recently-active known tickets' messages, and a rotating **deep sweep** walks the whole workspace listing a couple of pages per tick so ALL historic conversations land on customer timelines automatically (unknown senders become Leads + unmatched heads — never auto-created Contacts, §11) |
| `trengo/unsnooze-due` | every 5 min | Flip any `snoozed` Conversation whose `snoozedUntil` passed back to `open` (ADR 0020) |
| `trengo/retry-pending-send` | every 5 min | Re-attempt outbound Interactions stuck in `pending_send`; skip `TOKEN_EXPIRED` (agent must reconnect) (ADR 0020) |
| `webinar/dispatch-weekly-emails` | hourly | Send the weekly class email (Zoom link + PDF schedule) for any session whose send window has opened (ADR 0031) |
| `webinar/expire-enrollments` | hourly | Expire webinar enrolments whose Stripe subscription has lapsed so the links stop |
| `webinar/detect-enrollments` | daily 06:30 UTC | Scan active Stripe subscriptions and organise weekly-class payers into classes |
| `webinar/zoom-rotation-reminder` | weekly Mon 08:00 | **Auto-rotate** each class Zoom link older than its rotation interval (default 4 weeks): a fresh open-to-all meeting is created and the old link dies, so the next weekly email carries the new one (ADR 0035 amendment). Falls back to a reminder Task when the per-class `zoomAutoRotate` toggle is off, Zoom isn't connected, or the rotation fails. |
| `webinar/send-recordings` | hourly | Email each class its Zoom cloud recording after a session, then optionally trash it (ADR 0035, opt-in, off by default) |
| `gocardless/setup-link-maintenance` | hourly | Expire Direct Debit setup links past their 14-day window and auto-send the single 3-day reminder email to anyone who hasn't completed their mandate (ADR 0038 amendment). One nudge only — after that it's a human decision. |
| `finance/dd-chase-tick` | hourly | Automated Direct Debit chasing (ADR 0045). Per armed case: auto-resolve when the GC mirror shows a fresh ACTIVE mandate (they signed back up — messages stop by themselves); else send the due chase on each enabled channel (email via system Gmail — with the template's letter-before-action **PDF attached**; SMS via Trengo under the case owner's token — for a **standalone person** (no CRM contact) via `sendStandaloneMessage`, else the contact's thread), walking the staff-authored `DdRecoveryTemplate` sequence so each step is more serious; when the sequence is exhausted, stop + flag for a human. Never sends without the staff-pasted re-signup link. Every send logged (`DdCaseMessage` + timeline note when a contact is linked + audit). |
| `trengo/retry-pending-send` | every 5 min | Re-send outbound Trengo Interactions stuck in `pending_send` (ADR 0020 Phase 7a). Bounded at 5 attempts per row; skips TOKEN_EXPIRED (the agent must reconnect). |
| `trengo/unsnooze-due` | every 5 min | Resurface snoozed conversations whose `snoozedUntil` has passed (ADR 0020 Phase 6g). Flips `Conversation.status` snoozed→open + SSE-nudges open inboxes. A new inbound also resurfaces immediately (webhook job). |
| `invoicing/reconcile` | every 2 min | Walk the B2B Invoices Platform `/api/v1/events?since=<cursor>` feed and apply each event idempotently — the durable heal/backstop for any dropped webhook (ADR 0036). No-op when the invoicing API key is unset. Also event-triggered (`invoicing/reconcile.requested`). |
| `summer-camp/sync-bookings` | every 15 min | Re-pull Summer Camp bookings changed in the last `SUMMER_CAMP_SYNC_LOOKBACK_DAYS` (default 3) from `GET /api/external/bookings?since=` and apply idempotently — safety net for any missed booking webhook, and imports new bookings even if the push isn't configured. No-op when `SUMMER_CAMP_API_*` unset. Logs counts (reconciliation), the live webhook is the per-booking audit source. |

**Event-triggered backfill workers (ADR 0017).** Not recurring — fired once on first-connect (Gmail/Trengo) or by an admin button (Aircall/Slack/Summer Camp). `gmail/backfill.requested`, `aircall/backfill.requested`, `trengo/backfill.requested`, `slack/backfill.requested` each pull the last 90 days of history and write retroactive Interactions for matched Contacts. **Gmail also has a windowed manual import** — `admin.backfill.gmailImport` (Sales Executive+, the caller's own mailbox) walks `users.messages.list` with an `after:`/`before:` date query for any window up to ~20 years ("Everything"), so a brand inbox can pull its full history; the "Import history" control sits next to Connect on Settings → Mailbox (`GmailImportButton.tsx`). Backfilled email Interactions reach **parity with the live sync** — same `bodyHtml` capture (ADR 0041 reading pane) and the same **B2B-account stamping** (below). `summer-camp/backfill-bookings.requested` (admin button on `/camps`, CEO + Senior Manager) walks the camp app's keyset booking feed page-by-page (self-rescheduling on the cursor) to import ALL current bookings. `backfill/gocardless.requested` (button on `/direct-debits`, CEO + Senior Manager — ADR 0038) walks the FULL GoCardless history (customers → mandates → subscriptions → payments, keyset cursor, self-rescheduling per page) into the complete provider mirror. Idempotent on the provider's native id; concurrency-capped (Slack 3 as it is AI-heavy, others 1–2). One summary audit row per job — never per imported message.

**Lead classify + route (`lead/classify.requested`).** Event-triggered, not cron — fired by the universal `/api/leads` endpoint (and the legacy lead webhook path) once per submission (ADR 0023, §16). The pure orchestration is `packages/jobs/src/leads/process-lead.ts`; the worker boundary (`apps/web/app/api/inngest/_boundary/process-lead.ts`) injects the advisory AI enrichment. Normalises → classifies (rules + optional AI) → matches/onboards a Contact → routes onto the Sales Pipeline with the 24h re-enquiry dedupe. Idempotent (skips once `Lead.classifiedAt` is set); concurrency-capped at 3 (AI-touching). Pure decisions live in `packages/core/src/lead/`.

**Direct Debit issue scan (`finance/flag-dd-defaulters`).** Event-triggered, not cron — runs on `finance/reconcile.completed` (§17.3) so it reads consistent invoice/payment state. Recomputes the GoCardless defaulter set (`listDefaulters` in `packages/core/src/finance/dd-defaulters.ts`) and raises a `direct_debit_default` `ReconciliationDiscrepancy` (idempotent on `(familyId, category, contextHash)`) for any newly-defaulted family; the pure aggregator is `packages/jobs/src/finance/flag-dd-defaulters.ts`. The same job also runs `flagPlanIssues` (ADR 0038 sixth amendment): for family-linked plans it raises `direct_debit_plan_shortfall` (fixed-length plan cancelled/finished early with money still due — `listPlanShortfalls`) and `direct_debit_plan_arrears` (active plan behind its expected collection schedule — `listActivePlanArrears`), both in `packages/core/src/finance/dd-plan-shortfall.ts`, and **self-heals** by resolving any open plan discrepancy whose plan has recovered (the defaulter scan likewise resolves `direct_debit_default` rows for families no longer defaulting). The worker boundary (`apps/web/app/api/inngest/_boundary/flag-dd-defaulters.ts`) posts a combined summary to `#crm-finops`. **Go-live cutoff (ADR 0045 amendment):** each detector row carries a representative `issueDate` (last DD failure / plan end / latest collection); the job only raises/keeps discrepancies dated on/after `DD_ISSUES_CUTOFF_DATE` (default **2026-07-01**, `resolveDdIssueCutoff`) and stamps `ReconciliationDiscrepancy.issueDate`, so a bulk historic import (ADR 0038) of long-settled 2020-era failures no longer floods the dashboard "Needs attention" queue — pre-cutoff rows self-heal off it, while their recovery cases are never wrongly auto-closed (the plan-recovery close only fires for plans absent from the FULL, unfiltered set). GoCardless customers link to CRM contacts by unambiguous **email then phone** (`GcCustomer.phone`, `findContactForGcCustomer`), with a `linkUnlinkedGcCustomers` backfill for customers imported before their contact existed. Read-only analysis — never auto-charges or auto-duns (§3). Surfaced at `/direct-debits/issues`; per-customer payments are surfaced on the Family and Contact pages via `finance.customerPayments.*` (`packages/core/src/finance/customer-payments.ts`); the contact page additionally carries a **Direct Debit panel** (`ContactDirectDebitPanel`, tRPC `gocardless.contactSummary` — read-only for all staff, send-setup-link for Manager+) showing the contact's GoCardless customer, mandates, plans, recent collections and outstanding sign-up links, deep-linking into `/direct-debits/customers/[id]`.

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
| Company knowledge Q&A (AI Knowledge, ADR 0040) | gpt-4o (standard) | Grounded on the FULL live Crib knowledge base (~90k input tokens/call); quotes prices/dates verbatim, refuses outside it |
| Knowledge AI editor (propose patches, ADR 0040 §5) | gpt-4o (standard) | Instruction → JSON patches over the knowledge base; human reviews + applies, never auto |

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

`Contact`, `Family`, `FamilyMember`, `FinancialAccount`, `Interaction`, `ProviderEvent`, `AuditLogEntry`, `RetentionPolicy`, `SafeguardingFlag`, `Booking`, `BookingSession`, `Allocation`, `RefundIntent`, `ReconciliationDiscrepancy`, `Mandate` (`GcMandate`), `Subscription` (`StripeSubscription`), `Invoice`, `Payment`, `Lead`, `Task`, `User`, `RoleAssignment`, `EncryptedField`, `PipelineStage`, `Board`, `Card`, `Label`, `CardLabel`, `Subject` (ADR 0018), `BrandingSetting` (custom logo, §4), `MailAccount` + `MailAccountMember` (Communications Hub multi-account foundation, ADR 0021), `TrengoUser` (Trengo team mirror — agents synced from `GET /users`, auto-linked to a CRM `User` by email; drives the assignee picker + assignee/sender name resolution, §11), `TrengoChannel` (Trengo channel mirror — the workspace's named "business numbers" / inboxes synced from `GET /channels`; `Conversation.trengoChannelId`/`trengoChannelName` record which line each conversation is on, surfaced as the named **Channels** rail folders + the thread-header channel chip, §11), `ChatChannel`, `ChatChannelMember`, `ChatMessage`, `ChatMention`, `ChatMessageRef`, `ChatReaction`, `ChatAttachment`, `ChatPin`, `ChatSavedItem` (internal team messaging, ADR 0022), `LeadSource` · `BrandDomainRule` · `UrlClassificationRule` · `ProductCatalogueItem` · `LeadClassificationCorrection` (lead ingestion + classification, ADR 0023), `ContactBookingProfile` · `BookingLesson` · `BookingHoursTransaction` · `BookingCreditTransaction` · `BookingSyncCursor` (booking-site student mirror, ADR 0029), `SummerCampBooking` (Summer Camp instalment / deposit tracking — CSV-imported booking with total due + deposit received; remaining derived, §15 sibling), `AccountLabel` · `BusinessAccountLabel` · `ContactLabel` (shared custom label catalogue for B2B accounts + B2C customers), `ContactRiskReview` (manual flag/dismiss triage for the at-risk hours system), `CallPeakWindow` (customisable Aircall peak-times windows, §10), `InfoPackDocument` (info pack / brochure PDF library for call-summary emails, ADR 0039), `MissedCallReview` (manual actioned/dismissed override for the missed-calls workspace — the "called back" state itself is derived, §10), `GcCustomer` · `GcSubscription` · `GcPayment` (complete GoCardless provider mirror — Direct Debit operating system, ADR 0038, §9), `MandateSetupLink` (durable Direct Debit sign-up links + automated email state, ADR 0038 amendment), `KnowledgeOverride` (single-row live document for in-app edits to the Protocols & Policies knowledge base, ADR 0040 §5), `ConversationFavorite` (per-user "Favorite" star on a Conversation — Trengo Personal → Favorites folder; the `ConversationStatus` enum also gains `spam` for the Trengo Spam box, ADR 0020), `ConversationView` (per-user saved inbox filter — Trengo "Views" — captures folder filter + channel + label under a name, ADR 0020). Definitive shape: `prisma/schema.prisma`.

---

## 20. Auth, RBAC, and access control

**Auth.** Self-hosted Auth.js v5 (`next-auth`) backed by our Postgres handles sign in, session management, password reset, email verification, and TOTP 2FA — **standardised on Google Authenticator** (two-step sign-in with recovery codes; guided 4-step enrolment wizard at `/account/setup-2fa`, secrets KMS-encrypted; staff tutorial + ops runbook in `docs/runbooks/2fa-google-authenticator.md`). **Mandatory-enrolment policy** (`apps/web/lib/auth/mfa-policy.ts`, enforced in middleware, unit-tested): **ON for every staff role by DEFAULT** (operator request, 2026-07) — on first sign-in the user is sent to `/account/setup-2fa` and cannot use the CRM until they enrol. Not completing it never locks the account: they can sign out (a visible escape on the setup page) and are simply re-prompted next sign-in. After enrolment the wizard calls `useSession().update()` so the fresh `totpEnabledAt` propagates to the edge cookie immediately (the jwt callback also self-heals a null `totpEnabledAt`), which fixes the redirect-loop that made mandatory mode unusable. `MANDATORY_MFA_ENABLED=true` narrows the gate to `ceo`/`senior_manager`/`manager` (+ legacy aliases); `=false`/`off` pauses it (escape hatch); `=all`/unset = every staff role. The gate never redirects `/api/*` requests (a JSON caller redirected to an HTML page surfaces as "Unexpected token '<' … not valid JSON"). Sign-in shows email + password + an **always-visible optional two-factor code field** (a normal field, never a collapsed "dropdown"): accounts with two-factor turned on enter the code and sign in in one step; everyone else leaves it blank. An account that requires a code but leaves it blank still falls through to a dedicated focused code step (a `TOTP_REQUIRED` response, never an error), which also handles recovery codes. No third-party identity processor — see ADR 0010.

**Roles.** Five canonical sales-CRM roles (ADR 0014), with friendly UI labels via `formatRoleLabel`:

| Canonical enum value | UI label | Scope |
|---|---|---|
| `ceo` | CEO | Only role that can grant or revoke `ceo` / `senior_manager`. Rotates org-wide secrets, writes tenant config. |
| `senior_manager` | Senior Manager | Everything below CEO; manages all lower roles, runs Settings, DSAR exports. |
| `manager` | Manager | Sales + finance ops: refunds, payment links, allocations, reconciliation. Invites Sales Executives and Virtual Assistants. |
| `sales_executive` | Sales Executive | Full sales operations: contact/family/task/interaction CRUD, board cards, comms (email/Trengo/SMS/WhatsApp) send, payment links, **refunds**, **subscription cancellation**, and **account creation** (capped at Sales Executive / Virtual Assistant level). |
| `virtual_assistant` | Virtual Assistant | **Identical capabilities to Sales Executive** (operator decision, 2026-07). Same CRUD, sends, refunds, subscription cancellation and account creation — the two roles differ only in name/label, not in what they can do. |

> **Sales Executive ≡ Virtual Assistant (2026-07).** By operator decision the
> two roles share one identical capability set — `SALES_ROLE_ACTIONS` in
> `packages/core/src/auth/policies.ts` (contact read incl. minor, contact write,
> interactions, payment links, refunds, subscription cancel, account creation).
> Every "Sales Executive and above" gate across the routers therefore includes
> `virtual_assistant`. Two safety boundaries hold regardless: (1) the
> money/account actions gate on the policy actions (`charge.refund`,
> `subscription.cancel`, `user.invite`) or the explicit role sets, never the
> blanket finance gate — reconciliation, discrepancy resolution, GoCardless
> plan/mandate writes and imports stay Manager+/CEO-SM; (2) account creation is
> capped by `canCreateUserAtRole` so neither role can mint a Manager, Senior
> Manager, or CEO, and changing an existing user's role (`assignRole`) stays
> CEO + Senior Manager only — so this is not a privilege-escalation path.

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
| `contact.read` (minor) | ✓ (audited) | ✓ (audited) | ✓ (audited) | ✓ (audited) | ✓ (audited) |
| `contact.write` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `family.merge` | ✓ | ✓ | ✓ | — | — |
| `interaction.create` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `interaction.delete` | ✓ | ✓ | — | — | — |
| `charge.create_link` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `charge.refund` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `subscription.cancel` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `dsar.export` | ✓ | ✓ | — | — | — |
| `audit.read` | ✓ | ✓ | ✓ | — | — |
| `settings.write` | ✓ | ✓ | — | — | — |
| `user.invite` | ✓ | ✓ | — | ✓ | ✓ |
| `user.manage` | ✓ | ✓ | ✓ | — | — |
| `user.grant_manage` | ✓ | ✓ | ✓ | — | — |
| `user.deactivate` | ✓ | ✓ | — | — | — |
| `user.role.grant_senior_manager` | ✓ | — | — | — | — |
| `user.role.grant_ceo` | ✓ | — | — | — | — |
| `user.role.revoke_senior_manager` | ✓ | ✓ | — | — | — |
| `secrets.rotate` | ✓ | — | — | — | — |
| `tenant.config.write` | ✓ | — | — | — | — |

The canonical version of this table is generated from `packages/core/auth/policies.ts` so the doc and the code never drift. CI fails on mismatch (`pnpm policy:check`).

**User management (ADR 0021).** Account **creation** is CEO + Senior Manager only (`user.invite`; public self-service sign-up is disabled). **Editing** details, changing email, and **resetting passwords** require `user.manage` — held by role by CEO/Senior Manager/Manager, and additionally **grantable to any individual** via a `UserPermission` row (the only member of `GRANTABLE_ACTIONS`). `user.grant_manage` (CEO/Senior Manager/Manager) governs who may delegate that permission. Deactivation and role changes stay CEO + Senior Manager. A non-(CEO/Senior Manager) actor may never act on a CEO or Senior Manager account. New accounts and admin resets issue a **temporary password** (forced reset on first login via `mustResetPassword`) delivered in a branded welcome email plus a credentials PDF (templates + PDF in `packages/core/src/email/`, sent via Gmail (Google OAuth) through `sendSystemEmail` — never Resend). Both account creation and an admin password reset can either **generate** a temporary password or **set a specific one** (for when the user has lost access to their email), and may optionally skip the forced first-login change (`{ password?, requireChange }` on `create` and `resetPassword`).

**Custom roles (Settings → Roles & permissions, `/settings/roles`, CEO + Senior Manager).** On top of the five immutable built-in roles, operators create **custom roles** — named, coloured, additive permission bundles (`CustomRole` + `UserCustomRole`) assigned to users. A user's **effective actions** = base-role grants ∪ every assigned custom role's permissions ∪ per-user `UserPermission` grants (`loadEffectiveGrants`, `apps/web/lib/auth/effective-grants.ts`), consulted by `hasAction` and the `can(ctx, action)` / `assertCan` helpers (`apps/web/lib/auth/can.ts`). **Safe by construction:** custom roles are additive only (never remove a base grant); the catastrophic `DENY_LIST_ACTIONS` (secrets rotation, tenant config, the `user.role.*` grants, `user.deactivate`, `user.invite`, `user.grant_manage`, `dsar.export`) can never be bundled — only `ASSIGNABLE_ACTIONS`; and `sanitizeRolePermissions` forbids privilege escalation (an actor may only include a permission they themselves hold). Built-in roles stay in code (§20.1 / `policy:check`) and are shown as a read-only matrix. tRPC `role.*` (`apps/web/app/api/trpc/routers/role.ts`); pure policy in `packages/core/src/auth/policies.ts`; UI `RolesAdmin.tsx`. Enforcement reaches every gate that consults effective grants (user-management today via `loadActorGrants`); migrating the remaining hardcoded per-router role-Sets onto `can()` is the tracked follow-on.

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

Verification happens ONCE, in CI on `main` (one parallel turbo graph with a
persisted cache, cancelled when superseded by a newer push):
1. `pnpm typecheck` + `pnpm lint` + `pnpm test` + `pnpm build` + `pnpm policy:check`

The Railway Docker build then does the minimum a deploy needs — it does NOT
re-run the verification suite (that used to re-typecheck every workspace
package inside Docker on a cold cache and was the main reason deploys took
ages):
1. `pnpm --filter web exec next build` (the only step that produces artifacts)
2. `prisma migrate deploy` at container start (`scripts/deploy/start-web.sh`)

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

**Toasts.** A single Toaster mounted in the root layout — `AppToaster` (`apps/web/components/ui/app-toaster.tsx`): small light cards, bottom-right, auto-dismiss ~4s, semantic colour in the icon only. Pages never mount their own; every transient confirmation goes through sonner's `toast()`. `toast.error` only on user-facing actions; system errors go to Sentry, not to a toast.

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

- **Single branch: `main` IS the product. EVERY change ships to `main`.**
  All work lands directly on `main` as soon as it is green — no pull request,
  no waiting for a human reviewer. **This is non-negotiable and applies to
  EVERY kind of change without exception: features, bug fixes, refactors, and
  visual / design / "polish" / branding improvements alike.** A change is NOT
  considered done while it sits only on a `claude/<name>` (or any other)
  branch — "on a branch, not on `main`" means "not shipped". CI (typecheck +
  lint + tests + build + policy drift) is the mandatory merge gate; Railway
  auto-deploys `main` once CI passes. When a working session is forced onto a
  scratch branch by its harness (Claude sessions create `claude/<name>`
  branches), the session's **required final step** is to **fast-forward `main`
  itself** — `git push origin HEAD:main` after the full local verification
  (`pnpm typecheck && pnpm lint && pnpm test`) is green — never to leave work
  stranded on the branch waiting for a merge. (Fetch `origin/main` first; if it
  moved, rebase onto it before pushing. Never force-push `main`.) Scratch
  branches whose commits are in `main` are garbage; the **Cleanup merged
  branches** workflow (`.github/workflows/cleanup-branches.yml`, weekly +
  on-demand) deletes every branch fully contained in `main` automatically.
- **Verification replaces review as the gate.** The full local check before
  any push to `main` is non-negotiable: `pnpm typecheck && pnpm lint &&
  pnpm test`. Human review is asynchronous and advisory — request it (after
  landing) for schema migrations and money-moving changes; do not block a
  deploy on it. The safety rails that actually protect the data (idempotency,
  audit, fail-closed enums, human-confirmed money writes — §2) live in code
  and tests, not in the review queue.
- **Conventional commits** (`feat`, `fix`, `chore`, `docs`, `refactor`,
  `test`, `perf`, `revert`). The body explains the why.
- **Release cadence.** Continuous delivery to production from `main`. No batched releases.
- **On call.** One primary, one secondary, week-long rotation. Handover at Friday 16:00. The primary owns Sev 1 and 2 incidents; the secondary covers if the primary is unavailable.
- **Weekly review.** 30 minutes. Postmortems, dead-letter queue, reconciliation discrepancy backlog, AI cost forecast.
- **ADR.** Any non-trivial decision (new dependency, schema change with downstream impact, change to integration semantics) is recorded as an ADR before code lands.
- **Doc drift.** A change that contradicts CLAUDE.md updates CLAUDE.md in the same push.

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
| Change the home dashboard (`/`) | Page `apps/web/app/(app)/page.tsx` + skeleton `loading.tsx`; one round-trip `dashboard.summary` (`apps/web/app/api/trpc/routers/dashboard.ts`) returns role-aware **KPI tiles** + a **"Needs attention"** action-queue grid (Trengo unassigned · missed calls · leads · complaints · Slack mentions · field suggestions · finance discrepancies · DD issues · unresolved payments — finance queues gated CEO/SM/Manager; the DD-issues count honours the go-live cutoff `DD_ISSUES_CUTOFF_DATE`, default 2026-07-01, §9) + recent audited activity + the live **at-risk-customers** list (derived hours risk, §6.4) + an "Explore the workspace" jump-to grid. Queue assembly is the pure, unit-tested `apps/web/lib/dashboard/queues.ts` (`buildQueueCards`); components in `apps/web/components/dashboard/`. Missed-call + hours-risk counts reuse the shared core helpers (`projectCallInteraction` in `@studymind/core/calls`, `deriveHoursRisk` in `@studymind/core/contact`) and are bounded + resilient (degrade to "—" on failure). |
| Change the timeline display | `apps/web/components/timeline/` |
| Change a per-channel customer view | `apps/web/lib/view-models/contact-channels.ts` (ADR 0017) |
| Reply to a Trengo conversation from the CRM | tRPC `interaction.trengo.reply` — takes an optional explicit `{ticketId, channel}` (the comms centre passes the head's, so the send lands on the exact open ticket; falls back to the seed message's payload, then `resolveActiveTrengoConversation` in `packages/integrations/trengo/src/conversations.ts`); reuses `outbound.ts` `sendMessage`. Send button on `components/contact/draft-reply-panel.tsx`. The comms-centre composer (`ConversationReply.tsx`) mirrors Trengo: **inside the WhatsApp 24h window free text sends directly**; once closed it switches to the **approved-template mode** (Trengo `wa_templates`, inline `{{n}}` fill + live preview, via `interaction.trengo.startWhatsappTemplate`); a clearly-labelled **SMS tab** (when the contact has a phone) sends a separate SMS conversation via `startConversation`. Thread rendering is Trengo-style: named senders per bubble (`payload.senderName` — customer for inbound, Trengo agent for outbound, CRM author resolved from `createdById`), day separators, **centred lifecycle separators** ("Closed by … / Reopened by …" from the ticket_closed/reopened/assigned Interactions), label chips from `Conversation.tags`, and HTML email bodies rendered as readable text via `apps/web/lib/format/html-text.ts` (no raw-HTML injection, §44). The thread **header carries Trengo's signature Close (✓) / Reopen action** (`ThreadPane.tsx` → `interaction.trengo.{close,reopen}`, not buried in the composer), the composer offers Trengo's combined **"Send & close"** (`mutateAsync` chains the close only after the reply sends), and the internal-notes tab is labelled **"Comment"** (Trengo's term). The cockpit wears a **Trengo-style theme** — a dark folder rail with a **mint-teal accent** (the `trengo` colour token, a deliberate scoped §4 exception used ONLY under `inbox/*`; the rest of the product stays on `primary`). The rail mirrors Trengo's full folder taxonomy: **Inbox** (New / Assigned / All open / Snoozed / Closed / **Spam**) and **Personal** (Assigned to me / **Mentioned** / **Favorites**), live count badges via `inbox.conversations.counts`. **Mentioned** is derived from note @mentions (no extra table); **Favorites** is a per-user `ConversationFavorite` star (toggle in the thread header, `inbox.conversations.favorite`, shown as a row star); **Spam** is a CRM-side head status (`ConversationStatus.spam`, set via `inbox.conversations.setSpam` + the bulk `markSpam` action — like snooze, it does not push to Trengo). The rail also carries a **Teams** section (`inbox.conversations.teams` — each team a user can see + its open-conversation count; selecting one filters to that team's assignees via `list({teamId})`), a named **Channels** section (`inbox.conversations.channels` — the workspace's individual "business numbers"/inboxes by name with counts, from the `TrengoChannel` mirror + the channels in use; `list({trengoChannelId})` filters to one line; falls back to the generic 4 channel types before a mirror sync), a **Labels** multi-select dropdown (pick several labels → `list({tags})`, OR/has-any semantics, replacing the old cluttered label list), and a **Views** section (per-user saved filters — `inbox.conversations.views.{list,create,delete}`, `ConversationView`; "+" saves the current folder+channel+label combo, click to re-apply). The thread header shows the specific **channel name** ("Support Manager · WhatsApp"). **Spam is imported from Trengo** (not just a CRM toggle): the `TICKET_MARKED_AS_SPAM`/`_UNMARKED_AS_SPAM` webhooks + the reconcile/backfill map Trengo's `status:spam` into `ConversationStatus.spam`. A **"Sync from Trengo"** button (`inbox.conversations.syncNow` → `trengo/reconcile-now`, Sales Executive+) forces an immediate status convergence of the recent open set so "closed on Trengo, still open here" clears within minutes. The right context pane carries Trengo-style **contact custom fields** + clickable **previous conversations** (the contact's other threads) via `inbox.conversations.context`. list rows carry a **last-message preview** (`Conversation.lastMessagePreview`, maintained by the head merger from webhook/import/outbound bodies); the template picker is **searchable** with a phone-frame live preview. The right contact/ticket pane is a **static column on xl and a slide-over drawer below it** (so Assign / Snooze / Labels / Mark-read/unread / Task are reachable on every screen, not hidden off-canvas — the previous `hidden xl:flex` made them unreachable on laptops). The list supports **multi-select bulk triage** (checkbox per row + select-all → Mark read / Snooze 1d / Close, via `inbox.conversations.bulk`), **whole-inbox server search** (`inbox.conversations.search` — name/email/phone/subject/preview/labels across every conversation, not just the loaded page), per-conversation **Mark unread** (`interaction.trengo.markUnread`), and a dependency-free **emoji picker** in the composer. Roadmap: ADR 0020. |
| Send an attachment with a Trengo reply | `interaction.trengo.reply` takes `attachments[]` (base64, ≤8 MB each, ≤10). `sendMessage` uploads each via `client.uploadMedia` (Trengo `/media`) then sends with `attachment_ids` (Phase 6j). UI: an Attach button + file chips in `ConversationReply.tsx`. Assumed endpoints documented in the Trengo package README + pinned by `client.test.ts`. |
| Start a brand-new Trengo conversation with a contact | UI `StartTrengoConversation.tsx` (contact's Trengo section) mirrors Trengo's own composer: **WhatsApp lists the workspace's approved Trengo templates** (`contact.callSummary.waTemplates`), the agent fills each `{{n}}` variable inline with a **live preview bubble**, and sends via `interaction.trengo.startWhatsappTemplate` → `sendWhatsAppTemplate` (`POST /wa_sessions` — the only send WhatsApp accepts for a new thread); **SMS lists Trengo quick replies** (`interaction.trengo.quickReplies` → `GET /quick_replies`) as pick-then-edit templates with the same preview; Email stays free-text via `interaction.trengo.startConversation` → `client.createConversation` (`POST /messages`, with a documented fallback chain `GET /channels` → `POST /channels/:id/contacts` → `POST /tickets` → `POST /tickets/:id/messages` when the primary shape is rejected). A failed send is **visible**: the Interaction summary flips to "(failed — will retry)", the Trengo section + Activity timeline show a failed chip with the provider's actual error, and `trengo/retry-pending-send` keeps retrying (5 attempts). Sales Executive+. |
| Read the contact Activity timeline (honest labels, no duplicate spam) | `apps/web/app/(app)/contacts/[id]/Timeline.tsx` + pure logic `apps/web/lib/timeline.ts` (unit-tested). `interaction.list` now passes real DB types through (`mapDbType` no longer collapses messages/cards/summaries to `note`) and distils payload into a typed `meta` (call direction + duration, message channel, send status + last error — raw JSONB never reaches the client). The timeline renders colour-coded type chips ("Inbound call · 2m 10s", "WhatsApp message", "Card moved"), collapses runs of consecutive identical rows into one entry with a ×N badge (display-only, §3), shows sending/failed/sent chips with the provider error, and offers All/Calls/Messages/Emails/Notes/Cards/Other filter chips. |
| Connect or manage email accounts (personal + shared team inboxes) | Settings → Email accounts (`/settings/email-accounts`). Domain `packages/core/src/mail`; tRPC `mailAccount.*` (list / get / providers / createShared / update / setDefault / disconnect / members.\* / syncFromGmail); schema `MailAccount` + `MailAccountMember` (ADR 0021). `syncFromGmail` imports the agent's existing `GmailMailbox` rows via the bridge — reuse, not rebuild. Architecture + phased plan: ADR 0021. The legacy per-agent Gmail connect stays at `/settings/mailbox`. |
| Add a new email provider (Outlook / Exchange / IMAP) | ADR 0021 Phase 7 + a new ADR for the dependency. Add the entry to the `MAIL_PROVIDERS` capability registry (`packages/core/src/mail`, flip `connectable`); implement the `MailSyncProvider` seam (`packages/core/src/mail/sync-provider.ts`) under `packages/integrations/<provider>/src/mail-provider.ts`; add a case to the dispatcher `apps/web/lib/mail/get-sync-provider.ts`. Gmail is the live reference implementation (`packages/integrations/gmail/src/mail-provider.ts`). |
| Close / reopen a Trengo conversation from the CRM | tRPC `interaction.trengo.{close,reopen}`; outbound `closeConversation` / `reopenConversation` write a `ticket_closed` / `ticket_reopened` Interaction with `payload.source = 'crm_outbound'`; the webhook job's `linkCrmOutboundEcho` (`packages/integrations/trengo/src/jobs.ts`) stamps the trengoEventId onto that row so the echo never duplicates. Per-card buttons live in `apps/web/app/(app)/contacts/[id]/sections/TrengoConversationActions.tsx`. |
| Assign a Trengo conversation to a teammate from the CRM | tRPC `interaction.trengo.assign` (Manager+); outbound `assignConversation` resolves the target's `User.trengoUserId`, calls Trengo `assignTicket`, writes a `ticket_assigned` Interaction (`source: 'crm_outbound'`) + mirrors the head. Echo folded back by `linkCrmOutboundEcho`. Assignee picker `AssignControl.tsx` on the comms-centre thread; assignable users come from `interaction.trengo.assignableUsers` (only users with a Trengo identity). Stuck assignments recovered by the `trengo/retry-pending-send` cron. |
| Add/remove a label (tag) on a Trengo conversation, or mark read | Phase 6f. tRPC `interaction.trengo.{addLabel,removeLabel,availableLabels,markRead}` (Sales Executive+ for labels; markRead any staff). Outbound `addConversationLabel`/`removeConversationLabel` resolve the label name→id via Trengo `/labels` (creating it if new — the brief's tag "Creation"), `attachLabel`/`detachLabel` on the ticket, then mirror `Conversation.tags`, write a `source: 'crm_outbound'` Interaction, and the webhook echo (incl. label-name match) is folded back by `linkCrmOutboundEcho`; stuck rows recovered by `trengo/retry-pending-send`. Client API contract pinned by `client.test.ts`. UI: `TrengoThreadActions.tsx` on the comms-centre thread (parallels `MailThreadActions` for email). |
| Add an internal (team-only) note to a conversation | Unified path `inbox.conversations.notes.{list,add}` + `ConversationNotes.tsx` (ADR 0021 Phase 6 — works for every conversation, supports @mentions + teammate notification). For Trengo tickets `notes.add` also best-effort pushes to Trengo via `pushInternalNoteToTrengo` (`packages/integrations/trengo/src/outbound.ts` → client `POST /tickets/:id/notes`), stamping `trengoSync` on the note payload. Never sent to the customer. |
| Triage the inbox | tRPC `inbox.list` takes `filter: all \| mine \| unassigned \| snoozed` and respects `inboxAssigneeId` / `inboxSnoozedUntil` on the Interaction payload. UI chips at `/inbox` (`apps/web/app/(app)/inbox/page.tsx`). |
| Bulk-triage conversations | `/inbox/conversations` list rows are selectable (`BulkConversationList.tsx`); tRPC `inbox.conversations.bulk({ conversationIds, action })` does mark-read / snooze / unsnooze as a single head `updateMany`, and `close` loops the audited Trengo outbound per conversation (failures land in `pending_send` → recovered by the retry cron). Capped at 100 selected (ADR 0020 Phase 6i). |
| Add an internal note / @mention on a conversation | tRPC `inbox.conversations.notes.{list,add}` (ADR 0021 Phase 6, all staff incl. VA — §20). Stores a staff-only `note` Interaction scoped by `payload.conversationId` (never sent outbound); each `mentionUserIds` entry writes a `conversation.note_mentioned` audit row targeting that user so it lands in their notifications. UI: `ConversationNotes` (amber "Only your team sees this" panel) on the conversation thread view. |
| Read the current state of a Trengo conversation | `Conversation` table (ADR 0020 Phase 2). Upserted by the webhook job and the CRM outbound (`packages/integrations/trengo/src/conversation-head.ts`). Indexed columns: status, lastMessageAt, assigneeUserId, channel, unreadCount, tags. Message bodies stay in `Interaction` — the head is a queryable state layer, not a copy. |
| Surface an email thread in the unified inbox | `Conversation` head with `provider='email'`, keyed on `(provider, externalThreadId=gmailThreadId)`, optional `mailAccountId` (ADR 0021 Phase 3). Upserter `applyMailToConversation` (`packages/core/src/mail/conversation-head.ts`, pure + db-port, reusable by Outlook/IMAP) is called by the Gmail sync `processMessage` after writing the `email_received`/`email_sent` Interaction. Email heads list in the Comms Centre automatically; `inbox.conversations.get` joins email messages on `payload.gmailThreadId`. |
| Open the dedicated email workspace | `/mail` (ADR 0021 Phase 4, `apps/web/app/(app)/mail/page.tsx` shell → `MailWorkspace.tsx` client). **Gmail-class layout**: an icon folder rail (**Inbox** / Snoozed / Important / Sent / **Drafts** / Starred / **Spam** / **All mail** / Archived / Trash) whose membership is derived from each thread's live Gmail label set (`Conversation.gmailLabelIds`, §14 label-mirror) via the pure `buildGmailFolderWhere`, so every folder matches Gmail's own view; the Inbox shows Gmail's **category tabs** (Primary / Social / Promotions / Updates / Forums) as a tab strip, unread badges come from `mail.folderCounts`, and a **Sync from Gmail** button (`mail.syncNow` → `gmail/sync-now.requested`) forces an immediate convergence. **+ a Labels section** (Gmail's label sidebar — when a single account is selected `mail.labels` unions the mailbox's FULL live custom-label catalogue with `Conversation.tags` counts so it matches Gmail's sidebar incl. empty labels; selecting one filters via `mail.threads.list({label})`, `tags has`). The open conversation has a Gmail-style **Labels** menu (`LabelMenu` → `mail.thread.{labels,setLabels}`) to apply/remove labels on the live thread. With a Compose pill + Accounts, a Gmail rounded search bar (**real Gmail search** — `mail.threads.search` passes the query to Gmail's `q`, so full-body matching + every operator `from:`/`to:`/`subject:`/`has:attachment`/`is:unread`/`before:`/`OR`/grouping work natively; recent-searches dropdown + an advanced filter panel that builds the query), a **single main pane** (list XOR conversation, not a cramped split), **full-width single-line list rows** (checkbox · star · sender · subject — snippet · date that swaps to archive/trash/read **hover actions**), a **full-width conversation view** (back + toolbar, subject heading + star, message blocks with avatar/sender/date, Reply/Forward), and a **docked bottom-right composer** ("New message", From/To/Cc/Subject/body). Chrome is neutral; the exact Gmail-blue **`gmail` accent** (`packages/ui/tokens/colors.ts`, centred on #1a73e8) + amber (`secondary`) stars are a deliberate scoped comms theme (§37, mirroring the Trengo `inbox/*` exception) so it reads like Gmail, not the product purple — tokens only, no hardcoded hex. The page is **full-bleed** (no PageHeader, shell padding cancelled) so the client fills the viewport like Gmail. Keyboard shortcuts (j/k/e/s/u/#/r//c/Esc), debounced search, multi-select bulk actions (archive/read/trash), mark-read-on-open, rich-HTML reading pane (ADR 0041). tRPC `mail.accounts` + `mail.threads.list`; live via `useConversationStream`. |
| Why a /mail action button "does nothing" | Every action routes through `resolveEmailThread`, which needs the head's `mailAccountId`. Heads synced via the legacy Gmail connect have it null, which used to throw "Import this mailbox first" and made every button fail. `resolveEmailThread` now **self-heals**: it resolves (or creates) the `MailAccount` bridging the owning Gmail mailbox (matched by the thread's addresses, else the actor's default mailbox) and stamps the head, so actions just work. Only when no connected Gmail mailbox exists at all does it surface a reconnect prompt. |
| Why a synced email isn't on the customer's timeline | `processMessage`/backfill link by matching the message's from/to/cc/bcc against `Contact.email` **case-insensitively** (the match was case-sensitive `in`, so `John.Smith@x.com` never matched the lowercased header — fixed). A matched contact gets one `email_received`/`email_sent` Interaction (surfaced by `emailThreadsForContact` on the contact page) + the B2B-account stamp; unmatched mail never creates a ghost contact (§14). |
| Act on an email thread (mark read / archive / star / trash / label) | tRPC `mail.thread.{setRead,setArchived,setStarred,setTrashed,setLabels,labels}` (ADR 0021 Phase 5, Sales Executive+; VA read-only). Performs the action on the live mailbox via the `MailSyncProvider` seam (`getMailSyncProvider` → Gmail `users.threads.modify` / `trash`), reflects it on the Conversation head (incl. the `isStarred`/`isTrashed` columns), publishes the SSE delta, audits `mail.thread_*`. Reversible (trash → Gmail Trash). UI: `MailThreadActions` bar on the conversation view (email rows only). |
| Mirror a Gmail-side flag change back into the CRM (inbound two-way) | `mirrorThreadFlags` in `packages/integrations/gmail/src/jobs.ts`, driven by the `gmail/history.changed` job. The history pull (`GmailClient.listHistorySince`) returns `changedThreadIds`; each is re-read via `GmailClient.getThreadState`, mapped by the pure `deriveThreadFlags` (`thread-flags.ts`), and applied with `applyMailFlagsToConversation` (`packages/core/src/mail/conversation-head.ts`). Read→`unreadCount`, archive/trash→`status`, plus `isStarred`/`isTrashed`/`flagsSyncedAt`, **and the thread's current custom labels → `tags`** (the mirror loads the id→name map and passes `labels`, so a relabel in Gmail updates the chips). **Archive/read/star state is ALSO set at first sync**: `processMessage` + the backfill now call `applyMailFlagsToConversation(deriveThreadFlags(message.labelIds))` for received messages, so an archived-in-Gmail thread is created archived here — `/mail`'s Inbox matches Gmail's Inbox from the first sync, not just after a later change. Never clobbers a CRM `closed`/`snoozed`; a 404 marks the head trashed (§3). |
| Retroactively resync existing email threads from Gmail (flags + labels) | `mailAccount.resyncFromGmail({id})` (owner or Manager+) → `gmail/resync-threads.requested` → `gmailResyncThreads` (`packages/integrations/gmail/src/resync.ts`). Walks the account's existing email `Conversation` heads by keyset, re-reads each thread's current Gmail state via `getThreadState`, and converges flags (archive/read/star/trash) + custom labels — **head-only, never writes Interactions**, so it's safe to re-run. Self-reschedules per page (60/run). Fixes heads synced before flag/label capture (every thread showing "Inbox", no chips). UI: a **Resync** button per Gmail account on Settings → Email accounts. |
| Show the real Gmail sender name + custom labels in /mail | The sync captures the From header's **display name** (`parseFromName`, e.g. "Mohil Shah") **falling back to the From email ADDRESS** when there is no display name, and the thread's **custom Gmail labels** (`customLabelNames`). Both live + backfill set `payload.senderName` and pass `senderName`/`labels` to `applyMailToConversation`, which keeps `Conversation.lastSenderName` (latest inbound sender; **fill-blank** on older heads so a re-sync heals them) + `tags`. The list shows `lastSenderName` → **the latest inbound message's sender (retroactive read-time repair for legacy heads with no stored sender)** → matched contact → email. Critically it is **never the matched CRM contact for every row** — the previous behaviour, where a no-display-name (system / no-reply) sender fell straight through to one matched contact, made every conversation read "Mohil Shah". The thread view's per-message sender falls back to `payload.from[0]` too. |
| Render an email body as rich HTML (Gmail-identical look, images + inline styles) | ADR 0041. The Gmail sync extracts the `text/html` part, sanitises + size-caps it (`prepareEmailHtml`/`sanitizeEmailHtml`, `packages/core/src/mail/html-email.ts` — strips script/iframe/handlers/`javascript:`, keeps inline styles + images), stores `payload.bodyHtml`. The `/mail` reading pane's `EmailHtmlBody` frames a **dedicated same-origin render route** `/api/internal/mail-render/[interactionId]` (staff-gated, `contact.get` access gate) inside a sandboxed iframe (no `allow-scripts`/`allow-same-origin`). That route returns the email document with its **own** CSP (`default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'`, no scripts) + `X-Frame-Options: SAMEORIGIN` + `Referrer-Policy: no-referrer`, + `upgrade-insecure-requests` (so `http://` image URLs aren't blocked as mixed content), so **remote images and inline styles render** while the app's strict nonce CSP stays intact. A `srcdoc` iframe (the previous approach) **inherits the parent's CSP**, which blocked both — that is why images didn't load. The route is excluded from the global strict CSP/XFO in `middleware.ts` + `next.config.mjs`. **When a message has no stored `bodyHtml`** (synced before HTML capture), the route **fetches it live from Gmail** via the owning mailbox's client and caches it back onto the Interaction — so images render for old mail too; the pane renders for every message carrying a `gmailMessageId`, not only ones with pre-stored HTML. Inbound only today; HTML compose is a follow-up. |
| Save / resume / send Gmail drafts | tRPC `mail.drafts.{list,get,save,send,delete}` (Gmail-backed via `drafts.*`, covered by `gmail.modify`). Client methods `createDraft`/`updateDraft`/`getDraft`/`listDrafts`/`sendDraft`/`deleteDraft` (`packages/integrations/gmail/src/client.ts`); outbound `saveDraft` + `sendDraftMessage` (idempotent on `(draft:<id>, requestId)`, links contacts + audits like `sendEmail`). The `/mail` composer **auto-saves** (debounced) to a Gmail draft, **send** flushes then `drafts.send` (no duplicate, G3), discard deletes it; a **Drafts folder** (`DraftsList`) lists/ resumes/deletes. |
| Reply / reply-all / forward an email | tRPC `mail.thread.reply` ({conversationId, body, cc?, bcc?, replyAll?}) quotes the original + prefixes `Re:`; reply-all computes To=sender, Cc=others−us (`computeReplyAllRecipients`, `packages/core/src/mail/quote.ts`); `mail.thread.forward` ({to[],cc?,bcc?,body}) sends a NEW thread (`Fwd:`) with the original in Gmail's "Forwarded message" block + original attachments re-streamed from S3. Composer in `MailWorkspace.tsx` (Reply / Reply all / Forward + Cc/Bcc). |
| Reply to an email thread from the CRM | tRPC `mail.thread.reply` ({conversationId, body, cc?}) — reuses the Gmail `sendReply` outbound (`@studymind/integration-gmail/outbound`, idempotent on `(threadId, requestId)`), threaded against the latest inbound's `Message-ID`, sent from the account owner's mailbox; reflects the outbound on the head + audits `mail.thread_replied`. Sales Executive+. UI: `EmailReply` box on the conversation view (email rows). |
| Compose a brand-new email from the CRM | tRPC `mail.compose` ({mailAccountId, to[], cc?, subject, body}) — Gmail `sendEmail` outbound (literal subject, fresh thread, idempotent on `compose:<requestId>`), links matched Contacts, then `applyMailToConversation` creates the email head so it shows in `/mail` at once. Audits `mail.composed`. Sales Executive+; Gmail today (other providers with Phase 7). UI: `MailCompose` panel on `/mail` — has a To + collapsible **Cc** field and auto-appends the account's Gmail signature (swapped when the From account changes). |
| Copy / use an account's Gmail signature | `MailAccount.signatureHtml` (+ `signatureSyncedAt`), copied verbatim from Gmail `users.settings.sendAs` (readable with the existing readonly/modify scopes — no re-consent). Synced best-effort inside `mailAccount.syncFromGmail` via `GmailClient.listSendAs` + the pure `pickSignatureForAddress` (`packages/core/src/mail/signature.ts`, exact-address → default → primary; ignores visually-empty HTML). Surfaced on `mail.accounts` and auto-inserted in the `/mail` compose + reply boxes (rendered as plaintext today via `displayMessageBody`; full HTML send arrives with the rich composer). |
| Backfill the Conversation head from historic Interactions | Admin trigger `admin.backfill.conversationHeads.start` (CEO + Senior Manager only) fires `migration/backfill-conversation-heads.requested`. Self-recursive Inngest function `packages/integrations/trengo/src/backfill-conversation-heads.ts` walks 1000 rows per invocation ordered by `(occurredAt, id)`, scheduling the next batch with a cursor. Idempotent — replays converge to the same state. Audit at start + completion only. |
| Live conversation updates in the UI | SSE endpoint `apps/web/app/api/realtime/conversations/route.ts` (Node.js runtime, staff-gated). Event bus `packages/core/src/realtime/bus.ts` is published to by `applyEventToConversation` on every head change. Lazy-init Redis pub/sub when `REDIS_URL` is set (`packages/core/src/realtime/redis.ts`) so multi-instance Railway deploys see each other; in-process EventEmitter otherwise. Client hook `useConversationStream` (`apps/web/lib/hooks/use-conversation-stream.ts`) invalidates the comms-centre + per-contact channel + notifications queries. |
| Aggregate Trengo tags on a contact | View-model `trengoTagsForContact` in `apps/web/lib/view-models/contact-channels.ts`; tRPC `contact.channels.trengoTags`. Reads `Conversation.tags` directly, returns the frequency-ordered unique set. Rendered as chips above the contact's Trengo section. |
| Review a contact-field edit suggested by Trengo | `/inbox/suggestions` (staff-read, Manager+ accept/reject). Schema `ContactFieldSuggestion` keyed on `(source, sourceEventId, field)` for replay-safety. Pure diff in `packages/integrations/trengo/src/contact-suggestions.ts`; webhook job writes via `persistContactSuggestions` on `contact.updated`. tRPC `contactSuggestion.{list,accept,reject}`. Accepting writes the Contact + the suggestion row in one transaction; never silent-merge (CLAUDE.md §3). |
| Persist a Trengo message attachment | Webhook job fires `trengo/download-attachments.requested` when a message carries `attachments`. Worker `packages/integrations/trengo/src/attachments.ts` fetches via `safeFetch` (host already allowlisted), uploads to S3 with SSE:KMS via `packages/integrations/trengo/src/s3.ts` under `trengo/attachments/{interactionId}/{attachmentId}/{filename}`, then writes the result list onto `Interaction.payload.attachments[]`. Idempotent on the deterministic key. 20 MB per-file ceiling. |
| Download a Trengo attachment | Internal route `apps/web/app/api/internal/trengo-attachments/[interactionId]/[attachmentId]/route.ts` (Node runtime, staff-gated, restricted-access enforced via `contact.get`). Streams the S3 object back — never redirects to a presigned URL so the audit trail stays honest. Surfaced as chips in the comms-centre thread. |
| Download an email attachment | Internal route `apps/web/app/api/internal/mail-attachments/[interactionId]/[index]/route.ts` (ADR 0021 Phase 4, mirrors the Trengo route). Email attachments are streamed to S3 on Gmail sync (`payload.attachments[].s3Key`); `getAttachment` in `@studymind/integration-gmail/s3` streams them back, keyed by interaction id + array index. Same `contact.get` access gate. Surfaced as chips per message in the `/mail` reading pane (`mailAttachments` on `inbox.conversations.get`). |
| Map a CRM user to their Trengo identity | `User.trengoUserId` (Int, nullable, unique). Stamped at token-connect from `/me`; the webhook job resolves `assignee_id` → `User.id` via this column. Comms-centre badges render the resolved CRM name. |
| Recover a stuck outbound message | Cron `trengo/retry-pending-send` (every 5 min). Walks Interactions still in `pending_send`, re-attempts via the audited outbound, caps at 5 attempts per row. TOKEN_EXPIRED rows are skipped (the rotation banner is the recovery surface). |
| Start a backfill | `packages/core/src/backfill/index.ts` (workers in `packages/integrations/<svc>/backfill.ts`) |
| Import Trengo history into an empty CRM (seed contacts) | "Import history" control on Settings → Integrations → Trengo (`TrengoImportButton.tsx`, CEO/Senior Manager, needs a connected Trengo token) with a selectable window: 8 months (default) / 12 months / 2 years / everything (5 years). tRPC `admin.backfill.trengoImport` ({windowDays≤1825, createContacts}) → `startBackfill({provider:'trengo', createContacts})`. The worker (`packages/integrations/trengo/src/backfill.ts`) walks the **documented** `GET /tickets` listing (legacy `/conversations` kept as a one-shot fallback; window enforced client-side — package README), **creates** a Contact for senders not already in the CRM — the explicit, operator-confirmed exception to §11's webhook default — keyed on phone/email (DB-deduped, re-run-safe), `kind:'unclassified'`, tagged `referralSource:'Trengo import'` so the batch is filterable, and **replays each imported ticket onto the `Conversation` head** (incl. ticket **labels** → `tags`) so the comms centre / inbox shows the history immediately. The import also fetches the workspace's Trengo **users** once per run to stamp `payload.senderName` on outbound messages (sender attribution, re-run enriches older rows), stamps the customer's Trengo name on inbound rows, and resolves blank contact names through a **cheapest-first waterfall** (blanks only, never overwrite — §3): (1) the Trengo ticket contact's name, (2) rule-based extraction from the customer's own messages (`name-extract.ts`, unit-tested), (3) the budget-capped `contact_name_extraction` AI mini-task LAST (§18), and (4) when all fail the UI displays the contact's phone/email instead of "Contact". Ticket labels missing from the listing are read from the ticket detail (`labelsKnown`). The comms-centre rail filters by label (`inbox.conversations.tags` + `list({tag})`). The 90-day auto-on-connect backfill keeps its `createContacts:false` matched-only behaviour. The import also **mirrors the Trengo team** (`syncTrengoTeam` → `TrengoUser`, auto-linked to CRM users by email) and **full-syncs each ticket's labels** (the head's tags are SET to Trengo's exact current set, so a label removed in Trengo also disappears here) and its current assignee. Diagnostics: the Trengo integration page shows a "Message import health" strip (messages mirrored, conversation heads, contacts from import) and a "Test Trengo connection" probe (`admin.integrations.probeTrengo`, caller's own token). |
| Tweak an AI prompt | `packages/ai/prompts/<task>.ts` |
| Add a new background job | `packages/jobs/` |
| Change reconciliation logic | `packages/core/finance/reconcile.ts` |
| Manage Direct Debits (create/cancel/pause/resume plans, one-off payments, mandate setup links, full GoCardless history) | **Direct Debits** top-level nav section → `/direct-debits` (Overview master dashboard + Plans/Payments/Customers/Issues sub-routes; `/finance/direct-debit` redirects, ADR 0038, §9). Dashboard insights (monthly run rate) `packages/core/src/finance/dd-insights.ts`. Payout drill-down at `/direct-debits/payouts/[gcPayoutId]`; activity feed from `ProviderEvent` via `gocardless.events.list`. Customer drill-down at `/direct-debits/customers/[gcCustomerId]` (`gocardless.customers.detail` — identity, totals, mandates incl. cancel, plans, payments, sign-up links); Every workspace list (plans, payments, customers, mandates sub-view, payouts) is a proper URL-driven table: per-status counts, customer search, date/amount range filters, whitelisted sorting, offset paging with totals (shared list-controls primitives), and filter-honouring CSV export (cap 5000); a `?customer=` deep-link filter also prefills the New-plan / Collect-payment pickers. tRPC `gocardless.*`; outbound actions `packages/integrations/gocardless/src/outbound.ts`; mirror upserts `packages/core/src/finance/gc-mirror.ts`; import worker `packages/integrations/gocardless/src/backfill.ts`; hosted-flow completion `/api/gocardless/redirect-flow/complete`. Money writes Manager+; import CEO/SM. |
| Work Direct Debit collections — chase underpayers / cancelled-early DDs, message them, recover (ADR 0045 + amendment) | **One merged `/direct-debits/issues` tab** (the old separate *Chasing* tab is gone; `/direct-debits/chasing` redirects here). Top: the **recovery-cases worklist** (`RecoveryCasesSection`) — each row opens the **`CaseDetailModal`**: identity, outstanding, **all previous communication** (`DdCaseMessage` history, auto + manual), **send a manual message** (email via system Gmail / SMS via Trengo, from a `DdRecoveryTemplate`, PDF auto-attached), and the **automatic-recovery** controls (re-signup link · email/text toggles · pause/resume · mark up to date). Below: the **detected-issue** sources (defaulters + `direct_debit_plan_shortfall`/`_arrears`) with a "Show issues before July 2026" reveal. **A case works WITHOUT a CRM contact** — most defaulters predate the CRM, so `openManualChase` accepts a standalone `personName` + email + phone (`DirectDebitCase.personName`, contact/customer links all nullable), and the engine + `sendCaseMessage` route standalone SMS through `trengoOutbound.sendStandaloneMessage` (raw phone, no contact Interaction — the `DdCaseMessage` is the record). Engine `apps/web/app/api/inngest/_boundary/dd-chase.ts` (hourly, **7-day cadence**); pure decisions `packages/core/src/finance/dd-chase.ts`; tRPC `finance.directDebit.cases.{chaseList,caseDetail,openManualChase,updateChase,markUpToDate,chaseMessages,sendCaseMessage,draftMessage}` (reads all staff, writes Manager+). **Calculated CCJ costs:** the letters quote a real "if it goes to court" figure — England & Wales court issue fee (gov.uk EX50 scale) + 8% simple statutory interest (s69 County Courts Act 1984) — via `estimateCcjCosts` (`packages/core/src/finance/ccj-costs.ts`, verified July 2026) surfaced as `{{court_fee}}`/`{{interest}}`/`{{daily_interest}}`/`{{total_with_costs}}`/`{{late_fee}}`/`{{response_deadline}}` tokens; the shared var-builder (`apps/web/lib/finance/recovery-vars.ts`, `buildRecoveryVars`) feeds BOTH the engine and the manual-send preview so the customer sees one number. **Seeded sequence** (migration `20260719200000_seed_dd_recovery_templates`, idempotent): four escalating **email** templates + four matching **SMS/Trengo** templates, generalised (no personal names) + tokenised; the two `legal_escalation` email steps also attach a **generated PDF of the letter** (`renderRecoveryLetterPdf`, from the personalised body) plus any staff-uploaded accompanying PDF (`ddRecoveryTemplate.{attachPdf,removePdf}`, served at `/api/dd-recovery-templates/[id]/pdf`). Copy authored at **Settings → Direct Debit recovery** (`/settings/dd-recovery-templates`, Manager+) — the templates admin shows the sequence as two clear channel groups (**Email sequence** / **Text sequence**, each in step order, so the email+text pair per step no longer reads as duplication), plus a **Recovery settings** panel (`DdRecoverySettings` singleton, tRPC `ddRecoverySettings.{get,update}`) that makes the policy figures customisable — **late fee, cadence, response window, finance phone, letterhead** — read by the engine + sends via `loadDdRecoverySettings` (`apps/web/lib/finance/recovery-settings.ts`), env as fallback. The court fee + statutory interest stay calculated in code (fixed by law). **Optional "Refine with AI"** (`cases.draftMessage` → `packages/ai` `dd_recovery_draft`, §3/§18) lightly personalises an already-filled draft while keeping every figure/link/legal statement verbatim; agent reviews before sending. Stops on: fresh active mandate (auto), "Up to date ✓" (manual), pause, or sequence exhaustion (flags for a call). |
| Email a Direct Debit sign-up link (automated template + reminder) | Workspace Customers tab → “New Direct Debit setup link”. tRPC `gocardless.setupLinks.{send,list,resend,revoke}`; durable link domain `packages/core/src/finance/dd-setup-links.ts`; templates `packages/core/src/email/direct-debit-setup.ts`; sender `apps/web/lib/gocardless/setup-link-email.ts` (system Gmail, §14); public open route `/api/gocardless/setup/[token]`; hourly reminder/expiry cron `gocardless/setup-link-maintenance` (boundary). |
| Update RBAC rules | `packages/core/auth/policies.ts` |
| Manage staff users (create / edit / reissue login / delete / erase / permissions / avatars) | Settings → Users (`/settings/users`). tRPC `admin.users.*` (`apps/web/app/api/trpc/routers/admin/users.ts`); welcome email + credentials PDF in `packages/core/src/email/`; ADR 0021 + user-management upgrade. Account creation is CEO + Senior Manager only; self-service sign-up is disabled. **The delete ladder (ADR 0021 amendment):** `deactivate` suspends (reversible); `delete` (CEO/SM) soft-removes from the roster (hidden in a **Deleted** tab, sessions killed, roles revoked, sign-in blocked, reversible via `restore` which returns the account DEACTIVATED so it's never silently live with no roles); `permanentlyDelete` (CEO only, retype-email confirm) is a true **hard delete** — the `User` row is removed (FK children cascade, encrypted KMS envelopes crypto-shredded, assigned board cards un-assigned via SetNull), wrapped in a transaction with a friendly CONFLICT if some reference blocks it. Past `createdById`/audit `actorId` become unresolvable strings; the accountability record of the deletion itself is kept (`auth.user_erased`). Prefer the reversible `delete` for routine offboarding. **Reissue login details** = the existing `resetPassword` (temp password + welcome/reset email + credentials PDF). **Individual permissions:** `permissionsFor`/`setPermissions` (CEO/SM) grant specific capabilities on top of a role using the same safe `ASSIGNABLE_ACTIONS` set + `sanitizeRolePermissions` no-escalation guard custom roles use (`UserPermission` → `loadEffectiveGrants`); UI is the per-user Permissions modal. **Force sign-out** revokes all a user's sessions. **Login reminders:** the `users/login-reminders` cron (§17.1) emails staff who were given an account but never signed in (capped nudges via `shouldRemindLogin`, `packages/core/src/auth/login-reminders.ts`); manual `sendLoginReminder` per row. **Preset profile pictures:** `User.avatarKey` → a self-contained gradient SVG (`apps/web/components/ui/avatar-presets.ts`), picked on `/account` (`account.setAvatar`), rendered by the shared `<Avatar>` in the user list + top bar. |
| Create custom roles + assign permissions | Settings → Roles & permissions (`/settings/roles`, CEO + Senior Manager). Schema `CustomRole` + `UserCustomRole`; policy (`ASSIGNABLE_ACTIONS`, `DENY_LIST_ACTIONS`, `sanitizeRolePermissions`, `hasAction`) in `packages/core/src/auth/policies.ts`; effective-grant resolver `apps/web/lib/auth/effective-grants.ts`; gate helper `apps/web/lib/auth/can.ts` (`can`/`assertCan`); tRPC `role.*` (`apps/web/app/api/trpc/routers/role.ts`); UI `RolesAdmin.tsx`. Additive-only, no privilege escalation, catastrophic actions never assignable; built-in roles read-only (§20). |
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
| Change webinar matching / scheduling | `packages/core/src/webinar/` (matching.ts, schedule.ts); jobs in `apps/web/app/api/inngest/_boundary/webinar.ts` (Section 47) |
| Import a whole weekly-classes timetable (PDF → cohort + classes + schedules) | `webinar.timetable.{importPreview,commit}` (`commit`, not `apply` — reserved tRPC key) (`apps/web/app/api/trpc/routers/webinar.ts`); pure plan in `packages/core/src/webinar/timetable.ts`; AI prompt `packages/ai/src/prompts/webinar-timetable-import.ts`; UI `TimetableImport.tsx` on the **Groups** page `/webinars/groups` (Manager+). Deterministic CSV parse first (`parseTabularTimetable`), AI fallback. Builds everything except Zoom links — staff fill those in (§47). |
| Work on webinar Groups (the subject-offering workspace) | `/webinars/groups` (list + create + delete + import) → `/webinars/groups/[id]` (`apps/web/app/(app)/webinars/groups/`, `GroupsManager.tsx` / `GroupExtras.tsx`, reuses `classes/[id]/ClassDetail.tsx`). A Group = a `WebinarClass`; `webinar.class.{list,get,create,update,delete}` + `webinar.cohort.update` (term dates) drive it. `/webinars/cohorts*` + `/webinars/classes*` redirect here (§47). |
| Manage pipeline stages | `apps/web/app/(app)/pipeline/manage/page.tsx` + `ManageStagesTable.tsx` |
| Add a pipeline stage helper | `packages/core/src/pipeline/stages.ts` |
| Change how Family.stageId is written | `packages/core/src/family/pipeline.ts` (`moveFamily`) |
| Work on boards / cards / labels / subjects (ADR 0018) | `packages/core/src/board/` (domain), `apps/web/app/api/trpc/routers/board.ts` (tRPC), `apps/web/app/(app)/boards/` (UI). `/pipeline` redirects to the default board. |
| Clear a whole board (archive every card in one action) | `clearBoardCards` (`packages/core/src/board/cards.ts`); tRPC `card.clearBoard` (Manager+, `CARD_DELETE_ROLES`); toolbar button `ClearBoardButton.tsx` with confirm dialog. Soft-archives all live cards (contacts + history untouched), one `board.cleared` audit row. |
| Switch a board between kanban and list view | A per-board **view toggle** (`BoardViewToggle.tsx`) persisted in the URL `?view=list` (default kanban). `apps/web/app/(app)/boards/[boardId]/page.tsx` renders `BoardDnd` (kanban) or `BoardListView` (compact tables grouped by stage) off that param. The list view reuses the same `CardModal` (row-click), `MoveCardMenu`, and `QuickActionButtons` — no drag-and-drop, but identical actions/optimistic moves — so both views stay behaviourally in sync. |
| Ingest / classify web leads (Contact Form 7) — ADR 0023 | Endpoint `apps/web/app/api/leads/route.ts` + shared `apps/web/lib/leads/ingest.ts`; pure engine `packages/core/src/lead/` (normalise / classify / score / match); job `packages/jobs/src/leads/process-lead.ts` + boundary `apps/web/app/api/inngest/_boundary/process-lead.ts`; tRPC `lead.*`; UI `apps/web/app/(app)/leads/` + Settings → Integrations → Lead webhook panel. Event `lead/classify.requested`. |
| Sync a UCAT-portal (Medi Platform) account into a Contact — ADR 0037 | Endpoint `apps/web/app/api/contacts/route.ts` (bearer `MEDI_SYNC_TOKEN`) + `apps/web/lib/medi/ingest.ts`; pure engine `packages/core/src/medi/` (normalise + match); resolver `packages/core/src/contact/from-medi.ts`; job `packages/jobs/src/medi/process-account.ts`. Event `medi/account.received`. Creates a Contact + "imported" note + optional parent/student `ContactLink` — **no board card / pipeline**; dedupes on email/phone with leads + calls. Portal side: `server/util/crm.js` + `server/routes/auth.js` in the `ucatportal` repo. |
| Add/edit a brand-domain or URL classification rule, or a product | Tables `BrandDomainRule` / `UrlClassificationRule` / `ProductCatalogueItem` (seeded in migration `20260603120000_add_lead_classification`). Editable in the DB today; a Settings UI is a fast follow. Brand detection resolves to a `Company`. |
| Manage lead-source API keys (Contact Form 7 sites) | Settings → Integrations → Lead webhook (`LeadIngestionPanel`, Manager+). tRPC `lead.sources.*` (list / create / rotate / archive); schema `LeadSource` (sha256 key hash + last4, optional pinned brand). Raw key shown once. |
| Card sub-tasks (Todoist-style checklist on a card) | Schema `CardSubtask` (`cardId`, `title`, `completed`, `position`). Domain `packages/core/src/board/subtasks.ts`; tRPC `card.subtasks.*` (list / add / update / delete, Sales Executive+). UI `apps/web/app/(app)/boards/[boardId]/CardSubtasks.tsx` in the card modal. Distinct from CRM `Task` + contact-synced tasks. |
| Permanently delete a card (irreversible) | `deleteCard` in `packages/core/src/board/cards.ts`; tRPC `card.delete` (Manager+, `CARD_DELETE_ROLES`). UI: red **Delete** button in the card modal header next to Close (visible to Manager+ only). Cascades `CardLabel` + `CardSubtask` rows; preserves the backing `Contact` and every `card_moved` / `card_comment` Interaction on the contact timeline. Audits `card.deleted`. Distinct from `card.archive` (soft, Sales Executive+) which sets `Card.archivedAt`. |
| Manage a board's quick-action buttons | `/settings/board-quick-actions` (Manager+) lists boards → links to `/boards/[boardId]/settings` where the `BoardQuickAction` catalogue is edited. Firing is `card.applyQuickAction` (Sales Executive+). |
| Search contacts by phone in any format (spaces, no country code, trunk 0) | `phoneSearchDigitRuns` (`packages/core/src/contact/phone-search.ts`, unit-tested) turns a phone-shaped query into digit runs that `contains`-match `Contact.phoneE164` — wired into the global ⌘K search (`search.global`), the Contacts table (`contact.list`), and the contact typeahead. "07818 953024", "+44 7818-953024" and "7818953024" all find the same contact. |
| Bulk-merge duplicate contacts | `/contacts` table → select 2+ → Merge (Manager+). tRPC `contact.bulkMerge` ({survivorId, loserIds}); first selected row is the survivor, the rest merge in via `mergeContacts` (`apps/web/lib/services/contact-merge.ts`) one at a time. **Auto-find duplicates** at `/contacts/duplicates` (Manager+): `contact.duplicates.find` clusters contacts sharing a normalised email or last-9-digit phone (union-find, `packages/core/src/contact/duplicates.ts`, unit-tested), one-click Merge per cluster (human confirms — §3). Lead ingestion dedupes format-insensitively (last-9 phone suffix + case-insensitive email, `buildPhoneMatch`) so re-enquiries never create a new dupe. |
| Manage "Forward to <team>" quick actions | `/settings/forwarding` (Manager+). Domain `packages/core/src/forwarding/`, tRPC `forwarding.*`, sender `apps/web/lib/forwarding/senders.ts` (Gmail OAuth via `sendSystemEmail`). UI lives on the contact page (`ForwardingSection`). Records `email_forwarded` Interactions; defaults seeded by migration `20260529120000_add_forwarding_rules`. |
| Group ops staff into teams (one user → many teams) | Settings → Teams (`/settings/teams`, CEO + Senior Manager). Domain `packages/core/src/team/`, tRPC `team.*`, schema `Team` + `TeamMember` (M:N junction). |
| Track B2B partnerships and schools | `/accounts` (kind tabs). tRPC `businessAccount.*` (`apps/web/app/api/trpc/routers/businessAccount.ts`); schema `BusinessAccount` (kind: `school | partnership`, status lifecycle, address, notes) + `BusinessAccountContact` (M:N to Contact, optional `role`). Manager+ for writes; all roles read. The list (`AccountsList.tsx`) supports multi-select bulk actions (Manager+): archive/restore, permanent delete (hard delete, cascades children, audited), set status, and add/remove a label — via `businessAccount.{bulkArchive,bulkDelete,bulkSetStatus,bulkSetLabel}` (one audit row per affected account). Search + status + label faceted filters are URL-driven. The **detail page** (`/accounts/[id]`) carries the full workflow — stats, editable details, linked contacts, students, **Tasks** (raised against the account), **Notes**, Invoicing (b2b.studymind.co.uk live sync) + invoice files, and an **Activity** timeline — parity with the customer view. Notes + tasks hang off the account via an optional `businessAccountId` on `Interaction`/`Task`; tRPC `businessAccount.{notes,tasks,activity}.*` (notes/tasks write = Sales Executive+; audited `business_account.note_added`/`task_created`). `task.create` + `NewTaskDialog` accept `businessAccountId`. |
| Custom labels (shared, for customers + B2B accounts) | `/settings/account-labels` ("Labels", Manager+) curates one shared, colour-coded catalogue. Schema `AccountLabel` (name unique, `color`, `description`, `sortOrder`, `archivedAt`) with two sibling M:N junctions — `BusinessAccountLabel` (accounts) and `ContactLabel` (customers), both cascade. tRPC `accountLabel.{list,pickList,create,update,archive,attach,detach,attachContact,detachContact,bulkSetContactLabel}` (list/pickList any staff; CRUD Manager+; apply Sales Executive+). Applied in bulk from the Accounts list (`businessAccount.bulkSetLabel`) and the Customers list (`accountLabel.bulkSetContactLabel`), surfaced as chips on each row, and filterable (`labelIds`, AND semantics). The catalogue lives on `AccountLabel` for back-compat (forward-only §19); it is not customer-facing. Distinct from `Label` (board cards, ADR 0018) and `Company` (brand tags). |
| Filter / sort customers by hours + the at-risk system | `/contacts` table gains sortable Booked / Done / Left (hours) + Last-lesson columns, a "Has hours" toggle, and a per-row risk badge. The **at-risk customers system** lives at `/contacts/at-risk` (sidebar child under B2C Customers) — customers sitting on booked hours they aren't using (hours expire 12 months after booking → reach out before they lapse). Pure derivation `deriveHoursRisk` (`packages/core/src/contact/hours-risk.ts`, §6.4 — derived, never stored) combines three signals (under-use %, idle, expiry-soon) into a `none\|low\|medium\|high` level + score + reasons; thresholds configurable (`HoursRiskConfig` / `DEFAULT_HOURS_RISK_CONFIG`). Reads booking-mirror figures (`Contact.hours*`, `ContactBookingProfile.{hoursRemaining,nextHoursExpiryAt}`, ADR 0029). The dashboard (`AtRiskDashboard.tsx`) is interactive: per-row **flag / dismiss / clear** triage (persisted in `ContactRiskReview` — the human decision survives re-derivation; the risk itself stays derived) and a one-click **Create task** modal that opens a follow-up `Task` against the customer and flags them. tRPC `customerRisk.{list,setReview,clearReview,createTask}` (own small router for inference budget; review + task writes Sales Executive+, audited `contact.risk_flagged` / `contact.risk_dismissed` / `contact.risk_review_cleared` / `task.created`). `list` views: `open` (default, hides dismissed) · `flagged` · `dismissed` · `all`. |
| Filter B2C customers by subject / country / enquiry type ("Summer Camp", "UCAT", …) | `/contacts` faceted filters: **Subject** (`ContactSubject` tags, synced from the latest enquiry, options via `subject.list`), **Country** (`Contact.country` exact values) and **Enquiry type** (classification categories on the customer's converted leads, `Lead.categories hasSome`). Options for the last two come from `contact.filterFacets` (countries actually stored + categories actually seen), so new classification rules — e.g. a Summer Camp `UrlClassificationRule` — appear as filter options automatically. URL params `subjects`/`country`/`enquiry`; mirrored by the CSV export. tRPC `contact.list` inputs `subjectIds`/`countries`/`enquiryCategories`. The table also **shows** the data it filters: an Enquiry column with subject + enquiry-type chips per row (`ContactSummary.subjects`/`enquiryTypes`, batched via `loadContactEnquiryTypes` in `packages/core/src/stats/`), the same chips appear on board cards and in the contact-page header, and the CSV export carries Subjects + Enquiry types columns. |
| Manage call summary templates (UCAT, Medical Interview, Dental Interview, …) | `/settings/call-summary-templates` (Manager+). Schema `CallSummaryTemplate` carries the prefill body + optional inline PDF; tRPC `callSummaryTemplate.*` (list / pickList / get / create / update / archive / restore / attachPdf / removePdf). PDFs served at `/api/call-summary-templates/[id]/pdf` (authenticated, inline). Contact-page `CallSummarySection` reads the live catalogue via `pickList` and surfaces "Open PDF" on the chosen template. |
| Store info packs / brochures (PDF document library for call-summary emails) | `/settings/documents` (Manager+, ADR 0039). Schema `InfoPackDocument` (name unique, description, sortOrder, inline PDF bytes ≤8 MB, archivedAt); tRPC `infoPack.*` (list / pickList / create / update / replaceFile / archive / restore / delete — pickList any staff, writes Manager+, all audited `info_pack.*`); served inline at `/api/info-packs/[id]/file` (authenticated). Surfaced as one-click attachments in the call-summary wizard's **email step** only — deliberately NOT on the Trengo WhatsApp path (approved templates already carry the pack links). |
| Record + distribute a call summary (VA hand-off vs self-send) | Both the **contact page** (`apps/web/app/(app)/contacts/[id]/sections/CallSummarySection.tsx`, `contact.callSummary.*`) and the **board card modal** (`apps/web/app/(app)/boards/[boardId]/CallSummarySection.tsx`, `card.callSummary.*`) render the shared wizard `apps/web/components/contact/call-summary-wizard.tsx`, which opens with a fork — **Step 1: who's sending?** **"I'll send it now"** runs the self-send flow; **"Hand to a VA"** writes the summary and opens a `Task` for the VA team (preselected when a team matches /va/) to send it and clear it on the CRM — no customer message goes out on that path. Self-send: **Email?** (full-Gmail compose — **send-from picker** `contact.callSummary.mailboxes`, **To/Cc/Bcc** overrides, subject; templates / AI draft / quick replies; attach info packs (`InfoPackDocument`), contact docs, invoices, template PDFs, device uploads) → **Text or WhatsApp?** (pick WhatsApp/SMS + the **Trengo sender line** `interaction.trengo.channels` when several exist; approved **Trengo WhatsApp templates** `contact.callSummary.waTemplates` with per-param inputs + live preview, sent as a real HSM via `sendWhatsAppTemplate` `POST /wa_sessions`; no PDF picker on the template path) → **internal note** (+ person-or-team `Task`). One audited fan-out (`send` with `channelBodies`, `emailSubject`, `emailTo`/`emailCc`/`emailBcc`/`emailFromAddress`, `trengoChannelId`, `whatsappTemplate`); email replies on the latest Gmail thread, else (or when a From/To is set) **starts a fresh thread** via `sendEmail`. Best-effort per channel. **Compulsory Slack announce (ADR 0039 amendment):** EVERY completed summary — self-send AND VA hand-off, on the contact page, board card, or `/call-summaries` — is posted to the operator-routed `#callsummaries` channel via `contact.callSummary.announceToSlack` (resolved through the `call_summary` topic, ADR 0033; the wizard offers no opt-out). The post carries an unambiguous **disposition**: `sent_to_customer` (✅ "the sales team has already sent this to the customer (Email, WhatsApp) — no need to send it again" + any outstanding follow-up task), `va_handoff` (🚨 "VA team — action required: send it then clear it on the CRM" + the assignee), or `logged` (no customer message went out). Best-effort: a Slack failure surfaces a toast but never blocks the saved CRM record. Disposition layout in the pure `buildCallSummarySlackBlocks` (legacy `variant` retained for back-compat); channel senders `apps/web/lib/board/call-summary-senders.ts`; orchestrators `packages/core/src/{board,contact}/call-summary.ts`; Block Kit builder `packages/core/src/slack/blocks.ts`. ADR 0039. |
| Submit a call summary for anyone (incl. non-contacts) + smart de-dup | **Call Summaries** top-level nav section (`/call-summaries`, all staff). `apps/web/app/(app)/call-summaries/` (page + `CallSummariesWorkspace`): type who you spoke to (name / email / phone) and a debounced de-dup guard (`callSummaries.findContactCandidates`) resolves it to ONE existing contact — email → phone-variants → unambiguous full name, plus identifiers scanned out of the summary body via `extractIdentifiersFromText` — or surfaces candidates to pick; only a true miss creates a fresh contact (`contact.create`). Never auto-merges (§3). The resolved contact then drives the shared `CallSummaryWizard`. A recent-summaries queue (`callSummaries.recent`, all/mine) lists what's been logged. The matcher is the canonical `packages/core/src/contact/match-candidate.ts` (`matchContactByCandidate` / `phoneVariants` / `extractIdentifiersFromText`), also re-exported by the Slack mention archival path (one implementation). tRPC `callSummaries.*`. |
| Archive Slack messages about a customer (survives 90-day retention) | ADR 0034. The Slack parser (`slack/event.received` + 90-day backfill) only ingests **human-authored** messages — bot/app posts (incl. the CRM's own compulsory `#callsummaries` announcements, ADR 0039) are skipped by the pure `isIngestableSlackMessage` (`packages/integrations/slack/src/message-filter.ts`, needs `bot_id`/`app_id` on the event) so we never re-ingest our own post as a duplicate `slack_summary` (§3). It deterministically matches on an email/phone in the text first (free, AI-independent), else AI-classifies (mini tier) and, on a match above 0.5 confidence (email → normalised phone → unambiguous name incl. **single token / surname**, `matchContactByCandidate`), writes a `slack_summary` Interaction on the Contact storing the **original message** (`messageText`, `senderName`, `channelId`, `permalink`) so the record outlives Slack's retention, plus an AI **category** (`billing·scheduling·feedback·complaint·academic·logistics·sales·general` — `slackSummarySchema`). Surfaced on the contact page Slack section (category chip + original text) via the `SlackMention` view-model. Unmatched/ambiguous references park in `UnassignedSummary` and surface in the **triage tray** at `/inbox/slack-mentions` (also on the home dashboard "Needs attention" queue) — **on all three ingestion paths (webhook, 90-day backfill, recurring/on-demand pull), which share `processSlackMessage`; the backfill/pull previously dropped unmatched messages silently, the reason imported history "didn't show up"**: tRPC `slackSummary.unassigned.{count,list,assign,dismiss}` (Sales Executive+ to triage). `assign` files the mention to a customer **Contact OR a school/B2B account** (exactly one; a contact also stamps its primary school), so a parked org mention can be filed to the school by hand. **The tray is self-draining:** the `slack/relink-unassigned` cron (§17.1) re-runs the matcher over parked rows for free and auto-links the unambiguous ones (so a mention parked before its contact existed links itself once the contact appears). The webhook `GET` reports `aiConfigured` so it's obvious when a missing AI key is why name-only mentions aren't extracting. Never auto-create / auto-match on ambiguity (§12, §3). |
| Auto-raise a Complaint from a Slack complaints channel (ADR 0042) | Pure rules + draft: `packages/integrations/slack/src/channel-rules.ts` (`isComplaintChannel` — name contains "complaint"; `shouldAutoRaiseComplaint` — contact-linked + ≤7 days; `buildComplaintDraft`); idempotent executor `complaints.ts` (`Complaint.sourceKey = slack:<channelId>:<ts>`); hooked into the live webhook (`jobs.ts`), pull/backfill (`backfill.ts`) and relink (`relink.ts`). Complaints land on the normal `/complaints` queue. |
| Route which Slack channel each kind of notification goes to | `/settings/slack-channels` → "Where notifications go" (Manager+, ADR 0033). Schema `SlackRoute` (`topic` unique → `SlackChannelOption`, `enabled`); code registry `SLACK_TOPICS` (`packages/core/src/slack/topics.ts`: call_summary, google_voice, finance_dd_defaulters, cost_summary, security_alerts, general_alert). Senders call `resolveTopicChannelId(db, topic, fallbackEnvChannelId?)` (`packages/core/src/slack/route-resolver.ts`): route → env fallback → default option → `SLACK_ALERTS_CHANNEL_ID`; `enabled=false` mutes. tRPC `slackChannel.routes.{list,set}`; wired into the Google Voice handler + the dd-defaulters / cost-summary / UEBA boundaries. Add a new routable *kind* = add to `SLACK_TOPICS` (code); re-routing an existing one = no code. |
| Configure Slack channels for call-summary action points | `/settings/slack-channels` (Manager+). Schema `SlackChannelOption` (label, unique `channelId`, `purpose`, `isDefault`, `actionButtons` JSON `[{label,url}]`, `sortOrder`, `archivedAt`); deep-link buttons render as Block Kit on the Slack post — `{{contactUrl}}` is substituted at send time (no inbound Slack interactivity endpoint yet). tRPC `slackChannel.{list,pickList,create,update,archive,restore,discover,testPost}`; domain types `packages/core/src/slack/`. **Adding a channel is pick-by-name**: `discover` lists the workspace's public channels via `client.listChannels()` (`conversations.list`, needs the `channels:read` bot scope; fail-soft statuses `not_configured`/`missing_scope` render as in-app guidance, manual id entry remains the fallback + the only path for private channels). **Send test** (`testPost`) posts a one-off message via `postAlert` and maps Slack errors (`not_in_channel` → "/invite the bot") to friendly copy. The call-summary Slack sender resolves the picked channel → the default option → the legacy `SLACK_ALERTS_CHANNEL_ID` env fallback. |
| Customise Aircall peak times / export the call report as PDF | `/reports/aircall` (Manager+), tabbed Overview · Peak times · Performance (§10). Peak windows: schema `CallPeakWindow`, pure logic `packages/core/src/reports/peak-windows.ts`, tRPC `reports.aircall.peakWindows.*`, UI `PeakWindowsManager.tsx`; classified in Europe/London. PDF: `GET /api/reports/aircall/pdf` via `buildAircallReportPdf` (`packages/core/src/reports/aircall-pdf.ts`) + the paginating `renderPaginatedTextDocumentPdf` in `packages/core/src/email/pdf/pdf-writer.ts`. |
| Work the missed-calls queue / mirror all Aircall calls | `/calls` (all staff; action Sales Executive+). Inbound calls nobody answered (rang out OR voicemail), unknown numbers included. "Called back" is derived from a later outbound call to the same `payload.rawDigits` (format-insensitive) or the same linked Contact; manual override `MissedCallReview` (`calls.missed.{list,setReview,clearReview}`). Pure logic `packages/core/src/calls/missed-calls.ts`; UI `MissedCallsWorkspace.tsx`. Completeness: live webhooks + `aircall/sync-calls` cron + the historic backfill, all persisting matched **and** unmatched calls (`packages/integrations/aircall/src/{backfill,sync}.ts`). |
| Manage quick replies (canned conversation responses) | `/settings/quick-replies` (Manager+, ADR 0020 Phase 6h). Schema `QuickReply` (title, body, optional `channel`, shared via null `ownerUserId`); tRPC `quickReply.{list,create,update,archive}` (list = any staff). The comms-centre reply composer (`ConversationReply.tsx`) shows a per-channel "Quick reply…" picker that inserts the body with `{{first_name}}` / `{{name}}` substituted. |
| Upload an invoice file against a B2B account / Contact / Family | `<InvoicesPanel target={…}>` (`apps/web/components/invoices/InvoicesPanel.tsx`) is mounted on `/accounts/[id]`, `/contacts/[id]`, `/contacts/families/[familyId]`. Schema `UploadedInvoice` has three optional FKs with a DB check that exactly one is set; tRPC `uploadedInvoice.*` (list / create / update / archive / restore / delete). File bytes inline (8 MB cap); served at `/api/uploaded-invoices/[id]/file`. Sales Executive+ uploads / updates; Manager+ deletes; Virtual Assistant read-only. Distinct from the finance-mirrored `Invoice` table. |
| Raise / send / chase / preview a live invoice on the B2B Invoices Platform (two-way sync) | `packages/integrations/invoicing/` (ADR 0036). `client.ts` (full REST + SSE), `outbound.ts` (raise / edit / issue / send / send-reminder / record-payment / remove-payment / mark-paid / cancel / reissue / duplicate — all audited), `sync.ts` (idempotent inbound upserts + deletes), `jobs.ts` (`invoicing/event.received` skips `source:'api'`; `invoicing/reconcile` heals via the events feed). Webhook receiver `apps/web/app/api/webhooks/invoicing/route.ts`; tRPC `invoicing.*` (config / customers / invoices / reference); UI on `/accounts/[id]`: `AccountInvoicingPanel.tsx` + the full-parity `RaiseInvoiceForm.tsx` (5 client types incl. `alt_provision`, VAT toggle, billing-company/bank-account pickers, bill-to/PO/from-email/payment-ref/terms, printed + internal notes, line items, and create-time **adjustments/already-paid** recorded as payments), `InvoiceComposeModal.tsx` (prefills the platform's rendered template via the assumed `GET /invoices/:id/email-preview?type=send\|reminder` so staff never retype — un-edited fields are omitted so the platform's exact template goes out; editable to/cc/subject/body for send + reminder), `InvoicePdfPreview.tsx`, `InvoiceActivityModal.tsx` (per-invoice **email & activity history** from `GET /invoices/:id/activity` — every send/reminder/payment/status change + time). Byte-identical **PDF preview/download** proxied (key stays server-side, audited) at `/api/internal/invoicing/invoices/[invoicingId]/pdf` — framed as a `blob:` (the app's own `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` would block a direct same-origin frame; `frame-src 'self' blob:` admits the blob). `International` invoices are VAT-free; `lastReminderAt` is stamped on reminder. Invoice reads are open to all staff; writes stay role-gated. Mirror tables `InvoicingCustomer/Invoice/LineItem/Payment` + encrypted `InvoicingSetting`; money in pence. Connect at Settings → Invoicing. Distinct from the `UploadedInvoice` file store above and the finance-mirrored `Invoice` table. |
| Sidebar external links (Main Portal / Invoice Site) | Configurable via `NEXT_PUBLIC_MAIN_PORTAL_URL` and `NEXT_PUBLIC_INVOICE_SITE_URL` (defaults: `portal.studymind.co.uk`, `b2b.studymind.co.uk`). Rendered as an "External" group at the bottom of `apps/web/app/(app)/sidebar-nav.tsx`. |
| Track students enrolled at a B2B account | `<AccountStudents accountId={…}>` on `/accounts/[id]`. Schema `BusinessAccountStudent` (firstName / lastName / yearGroup / programme / hoursContracted / hoursDelivered / status / subjects / notes / bookingStudentId / bookingLastSyncAt). tRPC `businessAccount.students.*` (list / create / update / archive / syncFromBooking). `syncFromBooking` fetches the student from booking.studymind.co.uk by `bookingStudentId` and writes `hoursDelivered` + `bookingLastSyncAt` (ADR 0029); it returns a `synced | skipped` status (skipped when `BOOKING_API_TOKEN` is unset, no id is set, or no match is found). |
| Country picker with flags on Contact + Account forms | `<CountrySelect>` (`apps/web/components/ui/country-select.tsx`) backed by `apps/web/components/ui/countries.ts` (all ISO 3166-1 countries, flag emojis derived from regional-indicator code points). Stored value is the English display name — same shape as existing free-text country columns, so legacy rows render cleanly. |
| Phone number input with country-code + flag dropdown | `<PhoneInput value onChange>` (`apps/web/components/ui/phone-input.tsx`) — a country dial-code dropdown (flag + name + `+code`) next to a national-number field, emitting **E.164** (the stored format, §29). Pure data + parse/compose helpers in `apps/web/components/ui/phone.ts` (dial codes per ISO 3166-1; `parsePhone` longest-prefix match with a primary preference for shared codes like +1→US, +44→GB; `composePhone` strips the national trunk `0`), unit-tested in `phone.test.ts`. Controlled like `CountrySelect`. Wired into every phone-entry form: new/edit contact, Quick-add, board Add-card. Reuse it for any new phone field rather than a raw `<Input>`. |
| Export a list to CSV | `<CsvExportButton>` (`apps/web/components/ui/csv-export-button.tsx`) + `apps/web/lib/csv.ts` (RFC 4180 escape, UTF-8 BOM so Excel auto-detects). Mounted on `/contacts`, `/accounts`, `/tasks`, and the InvoicesPanel header. List pages page through their tRPC procedure in 100-row chunks (cap 5000) so the export honours the current filter state. |
| Use the card / form / toolbar primitives | `apps/web/components/ui/`. `<Card>` + `CardHeader` / `CardTitle` / `CardBody` / `CardFooter` is the canonical surface for tiles + list panels — replaces inline `rounded-xl border border-neutral-200 bg-white shadow-card`. `<Field label="…" htmlFor="…" hint="…" error="…">` pairs a label with any input/select/textarea; error wins over hint when both are set. `<Toolbar label="3 selected" clear={…}>` is the bulk-actions strip primitive (in use above the Contacts table). |
| Surface comms counts on list view-models | `packages/core/src/stats/`. `loadContactCommsCounts(db, ids[])` powers the Contacts table calls/texts/emails columns; `loadAccountStats(db, accountIds[])` rolls students / hours / paid-invoice spend / comms / last-contacted for the B2B Accounts table. Both are batched groupBy queries; safe to call once per page. |
| Click-to-call / click-to-email in list rows | `<PhoneLink>` and `<EmailLink>` in `apps/web/components/shared/channel-links.tsx`. Used by the Contacts table, Accounts table, and the board card preview. PhoneLink opens an Aircall (`tel:`) / Google Voice picker; EmailLink is a plain `mailto:`. Unlike the contact-detail CallButton these do NOT log an Interaction — they're scan-and-dial affordances. |
| Surface a synced/backfilled email on a B2B school/account | When an email's matched Contact belongs to a `BusinessAccount` (via `BusinessAccountContact`), the `email_received`/`email_sent` Interaction is also stamped with `businessAccountId` (the contact's primary account), so it shows on the account's Activity timeline next to notes/tasks — same direct-stamp pattern those use. Resolver `primaryAccountByContact` (`packages/integrations/gmail/src/business-account-link.ts`, pure `firstAccountByContact` unit-tested); wired into both the live `processMessage` and the historic `processBackfillMessage`. No domain→school matching — purely via the contact link. |
| Auto-create / enrich a Contact from an inbound call | `resolveOrCreateContactForCall` (`packages/core/src/contact/from-call.ts`, db+audit, exported via `@studymind/core/contact/from-call`). Match the counterparty E.164 → 0 matches create a Contact (phone + caller name/email, `referralSource`); 1 match backfills blank name/email (never overwrites, §3); >1 (shared line) returns `triageRequired` and never auto-merges (§41.1). Wired into the Aircall job (`packages/integrations/aircall/src/jobs.ts` `matchCallToContact`) and the Google Voice email handler (ADR 0032); idempotent across the several `call.*` events. A later web lead on the same phone fills remaining blanks via the lead re-enquiry path (`packages/jobs/src/leads/process-lead.ts`, ADR 0023). |
| Ingest Google Voice (voicemail / missed call / text) | ADR 0032. Google Voice has no call API, so we parse its `voice-noreply@google.com` notification emails through the existing Gmail sync. Pure parser `packages/integrations/gmail/src/google-voice.ts` (kind + name + best-effort E.164 + transcript, unit-tested); handler `google-voice-handler.ts` runs `resolveOrCreateContactForCall`, streams voicemail audio to S3, writes a `call`/`message` Interaction (`source:'google_voice'`, `needsManualReview` for voicemail + missed call), audits `google_voice.message_ingested`, and posts a best-effort Slack alert to the default `SlackChannelOption` (→ `SLACK_ALERTS_CHANNEL_ID`) so the team types up the summary / checks the missed call. Gated by the `google_voice.email_ingest_enabled` release flag (off until a GV number points at a synced mailbox). Upgrade path for live-call fidelity: port the number to Twilio/Aircall (reuses the same resolver). |
| Set / read the booking lifecycle for a Contact | `Contact.bookingStatus` enum (`lead | registered_no_hours | registered_with_hours`, default `lead`). Drives the Status column + filter on `/contacts`. The booking.studymind.co.uk puller (CLAUDE.md §15) is the only writer once wired; the CRM never auto-promotes a contact off `lead`. |
| Per-contact engagement metrics (hours / last lesson / spend) | `Contact.hoursBooked`, `Contact.hoursDelivered`, `Contact.lastLessonAt`, `Contact.amountSpentMinor`. Written per-contact by the booking site sync (ADR 0029) — explicitly NOT rolled up through Family (product direction, May 2026: contacts are students or parents/guardians, linked via contact relations rather than grouped into a Family). Null until first sync; the UI renders "—". |
| Mirror booking-site students / lessons / hours / credits (ADR 0029) | `packages/integrations/booking/` — `client.ts` (incremental keyset pull), `student-sync.ts` (pure map/match + db upserts), `jobs.ts` (4 crons, §17.1, no-op when `BOOKING_API_TOKEN` unset). Student → `Contact` (`bookingContactId`) + `ContactBookingProfile`; lessons → `BookingLesson` + timeline; ledgers → `BookingHoursTransaction` / `BookingCreditTransaction`; cursors in `BookingSyncCursor`. The contract the booking team builds is `docs/api/booking-pull-api.md`. |
| Sync Summer Camp bookings + view live camp roster/timetables (`camp.studymind.co.uk`) | `packages/integrations/summer-camp/` — **inbound (live)** `webhook.ts` (HMAC verify) + `apply.ts` (match/create guardian `parent` + attendee `student` Contacts, reciprocal `parent_of`/`child_of` link, `booking` Interaction on each timeline, sales-pipeline card, audit `summer_camp.booking.*`) behind `jobs.ts` (`summer-camp/event.received`); receiver `apps/web/app/api/webhooks/summer-camp/route.ts` (secret `SUMMER_CAMP_WEBHOOK_SECRET`). **Backfill + periodic sync (pull)** `jobs.ts` `summer-camp/backfill-bookings` (admin button on `/camps`, CEO+SM — walks `GET /api/external/bookings` to import all current bookings) + `summer-camp/sync-bookings` (cron, §17.1 — safety net). Pull path applies via the same idempotent `applyBookingEvent` (`audit:false`, summary audit only). **Outbound read feeds** via `client.ts` (`SUMMER_CAMP_API_URL`/`_API_KEY`, null when unset), tRPC `summerCamp.{status,camps,timetable,backfill}`, UI `apps/web/app/(app)/camps/` (camps running + the student-style day-by-day schedule). **Two-way write-back** (`writeback.ts`): a CRM note or identity-field edit on a camp-linked contact is pushed to the matching camp booking (`PATCH /api/external/bookings/:id` + `/notes`), hooked best-effort into `interaction.create` + `contact.update`; loop-safe (camp tags writes `system:crm`, doesn't echo; feed marks them `source:'crm'` so the CRM skips its own note). **Bookings workspace** (`/camps/bookings`, tRPC `summerCamp.bookings.{list,update,assignCamps,addNote}`): the per-booking surface — rows come LIVE from the camp's keyset feed (filtered via the pure `bookings-filter.ts`), and staff edit status/subject/booking-notes (`update` — Sales Executive+, cancellation Manager+), **assign the student to camps** (`assignCamps` → `PUT /api/external/bookings/:id/camps`, first id = primary, mirrors the camp's `student_enrolments`; the feed's `enrolled_camp_ids` field carries the full assignment back), and add shared notes (`addNote`, any staff — keyed on the camp's note id so feed round-trips never duplicate). Every write goes to the camp FIRST, patches the mirrored `booking` Interactions, audits (`summer_camp.booking_*_from_crm` / `booking_camps_assigned` / `booking_note_added`, §45), and fires `summer-camp/sync-bookings.requested` to converge in seconds. Camp stays the store of paid bookings — the CRM never creates one. Distinct from `booking.studymind.co.uk` (the tutoring platform). Contract: the camp repo's `CRM_INTEGRATION.md`. |
| Track Summer Camp **instalments / deposits** (who's paid a deposit, what's owed) | **Summer Camp section only** — `/camps/instalments` (linked from `/camps`). Our own DB-backed tracker, separate from the live camp roster. Schema `SummerCampBooking` (money in pence; `totalDueMinor` = the booking's total amount **due**, `depositPaidMinor` = received so far; **remaining is derived** `total − deposit`, never stored — §41.2). Loaded by **CSV import** of the booking sheet — pure RFC-4180 parser + deposit/total normaliser in `packages/core/src/camp/instalments.ts` (`parseInstalmentCsv`, unit-tested; reads `Amount Paid (£)` as the total, the £500-type deposit from the `Payment Type` + Notes). tRPC `summerCamp.instalments.{list,importCsv,update,remove}` (read = all staff; import/edit/delete = Manager+, audited `summer_camp.instalments_imported`/`instalment_updated`/`instalment_deleted`); re-import is idempotent on a `dedupeKey` (student email/name + subject + weeks). UI `apps/web/app/(app)/camps/instalments/` — cohort filter (on-instalments / balance-owing / all), payment-type + status facets, headline totals (due / received / **outstanding**), and an inline deposit edit to record a further payment. |
| Schedule a call on a board card (date + time, UK) | `Card.scheduledCallAt` (UTC). UI picks/renders Europe/London via `apps/web/lib/format/london-time.ts` (`londonWallToUtc` / `utcToLondonWall` / `formatLondon` — no tz library, leans on `Intl`). Sidebar field in `CardSidebar`; chip on `BoardCard`. Distinct from `Card.dueAt` (date-only), which stays as the generic deadline. |
| Work in the internal team chat (Slack-style) | `/messages` (ADR 0022). Domain `packages/core/src/chat/` (channels, messages, mentions, reactions, refs, read-state; the client-safe body grammar is `chat/parse.ts`, imported via `@studymind/core/chat/parse`). tRPC `chat.*` (`apps/web/app/api/trpc/routers/chat.ts`). UI in `apps/web/app/(app)/messages/`. Channels (public/private), DMs, threaded replies, @mentions, emoji reactions, and inline `<~type:id>` references to Contact/Family/Card/Task. Channel admin is Manager+ and audited (`chat.channel_*`, `chat.member_*`); messages are staff↔staff and deliberately NOT written to the customer timeline or the compliance AuditLog. |
| Company knowledge (products, pricing, playbooks, policies) | Lives on the **separate Crib site** (crib.studymind.co.uk), NOT in the CRM. The in-app Protocols & Policies knowledge base was **removed from the CRM** at the operator's request (2026-07) — no `/protocols` route or nav entry. The `knowledge.*` tRPC router + `packages/core/src/knowledge` (incl. `crib-data.json`) are retained dormant (forward-only §19); re-add a UI only if the section returns. |

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

- A change that contradicts CLAUDE.md updates CLAUDE.md in the same push.
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

## 47. Weekly webinars (live classes) — auto-enrollment system

Families pay weekly via Stripe for live online classes — **Biology, Chemistry, Physics, Maths** at **GCSE** and **A-Level** (subjects + levels are extensible — UCAT, GAMSAT, 11+, …). The CRM detects those payers, organises them into the right class, emails the Zoom link + a PDF schedule each week, and stops when a subscription lapses. The UI under `/webinars` (Operations) is **Group-centric**: a **Group** is one subject + level offering (e.g. "A-Level Biology"), backed by a `WebinarClass`, and is the single workspace for everything about it — This-week, Zoom + generate, its **weekly classes** (the schedule, with AI/CSV/PDF import), reminder email (its own template), settings, **term dates + holidays** (the academic year, surfaced as group settings), its **students** (manual add + Stripe auto), and a **broadcast** to email/WhatsApp/SMS everyone (`webinar.class.broadcast`). The top level is a flat **Groups** list (`/webinars/groups`) with create + **delete** + timetable import; subjects/levels are created inline from the New-group form. The legacy academic-year **Cohort** still exists under the hood (`WebinarCohort` owns term dates + holidays + a default template, shared by groups in the same year) but is no longer a browsing level — `/webinars/cohorts` and `/webinars/classes/[id]` redirect to Groups. ADR 0031 records the original design.

### 47.1 Domain model

New tables (forward-only migration `…_add_webinar_system`):

- **WebinarCohort** — an academic year ("2026/2027"), `startsOn`/`endsOn`, `status` (`planning | active | archived`), timezone. **Owns the email template** (`emailSubjectTemplate`, `emailBodyTemplate`, optional `emailBodyHtml`, `fromName`) **and the reminder schedule** (`sendDaysOfWeek` default Mon+Tue, `sendHourLocal`) for every class in the year — authored on the cohort page, not in global Settings. Future cohorts are created ahead and flipped to `active`.
- **WebinarHoliday** — fully-customisable break inside a cohort; no emails are sent on those dates. **Auto-detected** from an uploaded timetable/PDF on import (human confirms) as well as added by hand.
- **WebinarSubjectOption** / **WebinarLevelOption** — operator-managed catalogues (handle, label, aliases, sortOrder, archivedAt). Subjects (Biology, Chemistry, … Further Maths) and levels/types (GCSE, A-Level, **UCAT, GAMSAT, 11+**, …) are both **fully extensible from the UI** (`/webinars/subjects`) with no migration. The "New class" workflow reads them as dropdowns and the Stripe matcher builds its rules from them (label + aliases), so an added subject/level is recognised automatically.
- **WebinarClass** — one row per subject+level in a cohort (`@@unique([cohortId, subject, level])`). `subject` and `level` are free-string handles backed by the catalogues above (the legacy `WebinarLevel` enum is orphaned per §19). Holds the weekly slot (`dayOfWeek` 0=Mon, `startMinute`, `timezone`), the customisable `zoomLink` + rotation tracking (`zoomLinkUpdatedAt`, `zoomRotateEveryWeeks`, default 4), the **reminder send-day model** (`sendDaysOfWeek` default `[0,1]` = Mon+Tue, `sendHourLocal` default 9; `sendOffsetHours` is retained but deprecated), optional per-class template overrides, and either generated `WebinarSyllabusWeek` rows or an **uploaded syllabus PDF** (stored in Postgres like CallSummaryTemplate; attached verbatim to every reminder when present — works for any new class with no code change).
- **WebinarEnrollment** — a contact on a class's mailing list. `@@unique([classId, contactId])`. `status` (`pending_review | active | paused | expired | cancelled`), `source` (`auto_rule | ai_advisory | manual`), `matchConfidence`/`matchReason`, `billingInterval` (`month`/`year`), `expiresAt` (mirrors `current_period_end` — for a yearly plan that is ~1 year from purchase), and the external `stripeSubscriptionId`/`stripeCustomerId`.
- **WebinarEmailDispatch** — per-reminder-day, per-enrolment log; `@@unique([enrollmentId, weekNumber, sendDayOfWeek])` is the idempotency guard against double-sends.
- **WebinarSettings** — singleton (`id = "webinar"`): default email template, default send-days + send-hour, rotation interval, and the sending mailbox. Staff pick the **send-from address** on Webinars → Settings ("Reminders are sent from", `senderAddress` — a connected Gmail mailbox chosen from `webinar.settings.senderOptions`; null = the `SYSTEM_GMAIL_EMAIL` default, info@studymind.co.uk). It threads through `sendSystemEmail({ fromAddress })` → `createClientForAgent({ address })` on every path (dispatch, recordings, broadcast, both test sends). Creating a group is deliberately minimal (`NewClassForm`): subject + year-group/level + day/time + inline students, with the academic year auto-resolved (tucked-away "Change"); the group's meeting day/time is editable afterwards on its page.

### 47.2 Matching ("organise it on the app")

Pure logic in `packages/core/src/webinar/`. `detectWebinarClasses(...texts)` is the **authoritative** deterministic matcher (subject keywords + level keywords, multi-subject aware) and follows the rules-first / AI-advisory pattern (§3, §18, ADR 0030). It reads Stripe text — product/price names, description, **metadata** (`key value` flattened), customer name — and maps year groups (Y12/13→A-Level, Y10/11→GCSE) and ignores billing words. Confidence ≥ `AUTO_ENROLL_CONFIDENCE` (0.8) auto-enrols (needs an explicit level); everything else lands in the **review queue**. When the rules find nothing, the advisory `webinar_class_match` AI mini-task (`packages/ai/prompts/webinar-class-match.ts`, mini-tier, **per-run cached** by text to control cost) may suggest one or more classes — always `pending_review`, never auto-enrolled. The matcher is deliberately broad on **product names** (level wording such as "A-Level / A Level / AS / A2 / KS5 / Lower Sixth / Year 12 / Yr13", plural "GCSEs", exam boards) because most products carry the subject+level in the name; the AI fallback covers anything the rules miss. The **cohort is resolved by date** (`resolveCohortForDate`): the cohort whose range contains "now" (preferring `active`), else the soonest upcoming one — so a summer sign-up joins the new year, not last year. The matcher + AI both run against the **operator catalogues** (so UCAT/GAMSAT/added subjects match); the AI fallback is told the fixed handle lists and its output is filtered to known handles (it can never invent one). The **cohort is resolved by date** so a sign-up lands in the right academic year. The CRM also **knows what teaching week it is on** via `currentWeekInfo(sessions, now, tz)` (holiday-aware: `in_week | not_started | between | ended`, week N of M), surfaced on the overview, the classes list, and a "This week" card on the class page; the weekly reminder reflects exactly that week's session and attaches the class's stored PDF.

**Schedule import.** A class's weekly topics can be typed, or **imported from a CSV / PDF / pasted text** (`webinar.syllabus.importPreview`): the text is extracted (PDFs via Node `zlib`, dependency-free), AI-structured into weekly topics **and detected holidays/breaks** (`webinar_schedule_import` mini-task) with a deterministic fallback, shown for human confirmation, then saved via `syllabus.set` (topics) + `cohort.addHoliday` (confirmed holidays → the class's cohort). The uploaded PDF is still stored and attached to every reminder. Email **templates + send schedule live on the cohort** (`cohort.update`); the dispatcher resolves cohort → class-override → built-in default, sending text + optional HTML. Global Settings holds only the Zoom connection + sender (no email editor — de-duplicated). Each group additionally edits its **own** reminder email + term dates + holidays on its page (`GroupExtras.tsx`), and classes are managed as **Groups** (`/webinars/groups/[id]`), not under a cohort screen.

**Whole-timetable import (one PDF → cohort + classes + schedules).** The per-class importer above sets one class's topics; the **timetable importer** builds the entire setup from a single master timetable so staff only fill in Zoom links afterwards. On the Cohorts page (Manager+), `webinar.timetable.importPreview` extracts the PDF/CSV/paste text and runs the `webinar_timetable_import` mini-task (`packages/ai/src/prompts/webinar-timetable-import.ts`) to produce an **editable plan**: the academic year (name + term dates), its holidays, and every weekly group class (subject, level, weekday, start time, weekly topics). Pure normalisation in `packages/core/src/webinar/timetable.ts` (`buildTimetablePlan` — weekday/time parsing, catalogue-handle resolution flagging `isNew`, dedupe, warnings; unit-tested). Nothing is written until the human confirms (§3); `webinar.timetable.commit` then find-or-creates the cohort (by unique name), adds holidays, inline-creates any new subject/level catalogue option, find-or-creates each class (Group) per `(cohort, subject, level)` **with no Zoom link**, and sets each class's syllabus weeks — idempotent on re-run, audited (`webinar.timetable_imported` + per-cohort/class rows). **Deterministic-first** (CLAUDE.md §3/§18): `importPreview` parses a structured CSV/spreadsheet (`parseTabularTimetable` — column mapping, level-token stripping, date-ordered week renumbering, "No class" rows → holidays) with **no AI**, so a clean export imports offline; AI is the fallback for unstructured input and its real error is surfaced (not swallowed). UI: `TimetableImport.tsx` on the **Groups** page.

**Zoom integration (ADR 0035).** Optional, fully feature-flagged. **Connect from the UI** (Webinars → Settings): paste a Server-to-Server OAuth app's Account ID / Client ID / Client Secret — verified live against Zoom before saving, secret envelope-encrypted (§21, `apps/web/lib/webinar/zoom-config.ts`); the `ZOOM_*` env vars remain a fallback, and every Zoom caller resolves credentials via `loadZoomConfig` (Settings row → env → off). `webinar.class.generateZoomLink` (Manager+) creates a recurring meeting per class — **open to all** (join-before-host, no registration) with **cloud auto-recording** — and stores the join link + `zoomMeetingId`. **Regenerating deletes the previous meeting** so the old link dies (the point of rotation); archiving a class deletes its meeting too. **Links rotate automatically**: the weekly job regenerates any class link older than its interval (default 4 weeks) via the shared `rotateClassZoomLink` (`apps/web/lib/webinar/zoom-service.ts`); a per-class `zoomAutoRotate` toggle opts a group out (reminder Task instead, also the failure fallback). Optionally **auto-generate on class create** (`zoomAutoCreate`). Recordings reach the class two ways: the **`recording.completed` webhook** (`/api/webhooks/zoom`, HMAC-verified, URL-validation handshake handled → enqueues `webinar/recording.completed`) for near-real-time delivery, plus the hourly `webinar/send-recordings` sweep as a backstop; both email the active list and, opt-in (`zoomTrashAfterSend`, default off), move the recording to Zoom **Trash** (recoverable) after a successful send. Staff can also **send a recording now** per class, and **Test connection** in Settings. Everything fails closed when not configured. Client: `packages/integrations/zoom` (fetch-based, via `safeFetch`; `ZOOM_WEBHOOK_SECRET_TOKEN` for the webhook). Settings: Webinars → Settings.

### 47.3 Flow

`webinar.enrollment.detectFromStripe` (button on the Enrolments page) and the daily `webinar/detect-enrollments` job both call `detectEnrollmentsFromStripe` (`apps/web/lib/webinar/enrollment-service.ts`): list active Stripe subscriptions → resolve the current cohort → match → upsert enrolments (creating a Contact per payer if needed). A re-subscription **revives** an expired/cancelled enrolment (new sub id + fresh expiry). Staff can also **add/remove** people by hand (`enrollment.create` with a contact typeahead, `enrollment.remove`). Reminder emails go out via `webinar/dispatch-weekly-emails` (hourly): on each class's `sendDaysOfWeek` at/after `sendHourLocal`, for that week's session (holiday-aware, DST-correct), it renders the template, attaches the class's PDF (uploaded syllabus or generated schedule), and sends through the connected **Google/Gmail** mailbox (`sendSystemEmail`, §14, from info@studymind.co.uk) — no third-party email API. `webinar/expire-enrollments` (hourly) refetches the **live** Stripe subscription (source of truth, §4) — terminal status or a past period end expires the enrolment, so cancellations stop the links (Zoom-link rotation is the second line of defence). `webinar/zoom-rotation-reminder` opens a Task when a class link is older than its interval. All mutations are audited (`webinar.*`, registered in `packages/core/events/registry.ts`). Manager+ manages; all roles read.

---

— end of CLAUDE.md —
