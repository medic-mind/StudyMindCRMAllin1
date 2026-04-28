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
