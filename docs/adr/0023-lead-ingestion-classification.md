# ADR 0023 — Dynamic lead ingestion + AI classification engine

- Status: Accepted
- Date: 2026-05-30
- Supersedes: none
- Related: ADR 0014 (sales roles), ADR 0015 (dynamic pipeline), ADR 0018 (multi-board cards), CLAUDE.md §3, §11, §16, §18

## Context

The Study Mind group runs many WordPress sites (Study Mind, Medic Mind,
Oxbridge Mind, Law Mind, Vet Mind, and more to come) with dozens of Contact
Form 7 forms whose field layouts vary constantly (`text-618`, `tel-146`,
`webhook:name`, `your-email`, …). The forms already use CF7 webhook field
mapping, so the CRM must **not** depend on specific field ids. We need a single
endpoint that accepts any form payload, works for every existing and future
form without code changes, classifies the enquiry (brand, products,
categories, intent, score) primarily from the **landing page / URL / form**
(more telling than the message body), and routes it onto the Sales Pipeline.

The pre-existing `/api/webhooks/lead` endpoint (CLAUDE.md §16) was a fixed-shape
Zapier webhook with no classification, no field detection, and no UI — leads
landed as orphan interactions and were invisible.

## Decision

Build a dynamic ingestion + classification engine, reusing the existing
substrate (the `Company` brand model, `runStructured` AI client, `Board`/`Card`
pipeline, `ProviderEvent` raw store, Inngest, audit) rather than new systems.

1. **Universal endpoint** `POST /api/leads` (public, key-authenticated). Accepts
   JSON, form-encoded, multipart, and CF7 webhooks with any field names. Thin
   handler (§7): authenticate → parse → hand to the shared `ingestLead` core
   (normalise → dedupe → persist `ProviderEvent` + `Lead` → audit → enqueue
   `lead/classify.requested`) → return fast. The legacy `/api/webhooks/lead`
   stays for 12 months.

2. **Dynamic normaliser** (`packages/core/lead/normalise.ts`, pure). Detects a
   field's role from four signals in order: explicit `webhook:<role>` mapping →
   name synonym → CF7 type prefix (`tel-*`→phone) → value sniffing (email/phone
   regex, longest free-text → message). Then lifts landing-page intelligence
   (domain, slug, form title, UTM, referrer) from hidden fields, query params,
   or request headers. No field id is ever hardcoded.

3. **Deterministic classifier** (`packages/core/lead/classify.ts`, pure).
   Brand from configurable `BrandDomainRule`s (domain → `Company`); products +
   categories from configurable `UrlClassificationRule`s and the
   `ProductCatalogueItem` master catalogue; word-boundary phrase matching so
   short tokens (`mat`, `law`) don't false-match. Multi-category by design.
   Deterministic, free, and the authoritative result.

4. **Advisory AI enrichment** (`packages/ai` `lead_classification` task). A cheap
   `gpt-4o-mini` pass adds a summary, intent, urgency, and _suggestions_ —
   stored under `classification.ai`, never overriding the rules. Best-effort and
   budget-guarded: a missing `OPENAI_API_KEY` or a failed call never blocks
   ingestion. Injected into the job at the worker boundary so `packages/jobs`
   stays decoupled.

5. **Scoring** (`packages/core/lead/score.ts`, pure). Explainable 0-100 from
   contact-detail, brand/product, multi-service, and high-value-intent signals.

6. **Routing + dedupe (the key product decision).** The classify job
   (`packages/jobs/leads/process-lead.ts`) matches an existing Contact (email
   exact, then E.164 phone — never on an ambiguous/shared match, §41.1) and:
   - **first enquiry** → auto-create a Contact (tagged with the detected brand)
     and a card on the default board's "New leads" stage;
   - **re-enquiry** (matched) → no duplicate contact; annotate the contact's
     timeline, and add a fresh card **only if** >24h since the last enquiry
     (within 24h is one card — anti-spam);
   - **no email/phone, or ambiguous** → `needs_triage` in the Leads tray.
     All writes are atomic + idempotent (skipped once `classifiedAt` is set).

7. **Configurable without a developer.** Brand/URL rules and the product
   catalogue live in DB tables seeded by the migration; per-site API keys are
   minted from Settings → Integrations → Lead webhook. A rule-editing UI is a
   fast follow.

8. **Surfaces.** A Leads tray (`/leads`) for review/triage; the Integrations
   page gains the copy-paste webhook URL, API-key management, and a test-lead
   generator. Learning substrate: staff corrections are captured in
   `LeadClassificationCorrection` for a future pass that tunes the rules/AI.

## Override of the "no auto-create from web forms" rule

CLAUDE.md §3/§11 say never auto-create a Contact from an unmatched conversation
(spam-ghost risk from Trengo). The product owner explicitly chose auto-onboarding
for the **web-lead funnel**, with the 24h dedupe + conservative matching as the
anti-spam control, and a spam valve (a submission with neither email nor phone
goes to triage, not a ghost contact). This ADR records that deliberate override;
§11 is updated in the same change. The Trengo rule is unchanged.

## Alternatives rejected

- **A generic webhook gateway / per-form schemas.** Rejected — the whole point
  is to not maintain per-form code; the normaliser handles variety in one place.
- **AI as the primary classifier.** Rejected — domain/URL rules are more
  reliable, free, and instant; AI is advisory enrichment only (§18, §3).
- **Triage-tray-first (no auto-onboard).** Considered and initially chosen, then
  overridden by the product owner for a lighter, automatic funnel (above).
- **Hardcoded brand/product lists.** Rejected — rules are data so ops extend
  them without a deploy.

## Consequences

- New tables: `LeadSource`, `BrandDomainRule`, `UrlClassificationRule`,
  `ProductCatalogueItem`, `LeadClassificationCorrection`; `Lead` extended with
  classification + landing columns. New events registered (§45). New brands
  Law Mind + Vet Mind seeded.
- Web leads now create Contacts automatically — monitored via audit
  (`lead.converted`) and reversible (soft delete + the 24h dedupe).
- Custom stage names on the default board still resolve ("New leads" by name,
  else first non-closed stage).
- Follow-ups: rule-editing UI; use corrections to tune classification; manual
  "convert from triage"; per-source rate limiting at the edge.
