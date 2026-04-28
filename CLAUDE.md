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
