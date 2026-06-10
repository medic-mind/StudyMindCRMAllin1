# ADR 0037 — Medi Platform (UCAT portal) account → CRM contact sync

- Status: Accepted
- Date: 2026-06-10

## Context

The Medic Mind **UCAT portal** (the "Medi Platform", `portal`/the UCAT app — a
separate Express + Postgres product) lets students, parents, and teachers create
accounts. We want every new account to appear in this CRM as a **Contact**, with
a note recording that it came from the Medi Platform, so the sales/ops team has a
single view of who has signed up. Crucially, those contacts must NOT clutter the
call boards or the sales pipeline — a signup is a *record*, not a sales lead — and
later touches (a web lead, a missed call, anything matched by email/phone) must
**update the same contact** rather than create duplicates.

The portal side already exists: on `POST /api/auth/register` it fires
`crmSync('user.registered', { user, contact, … })` to
`https://crm.studymind.co.uk/api/contacts` with `Authorization: Bearer <CRM_API_KEY>`.
The matching **receiver in the CRM was never built** — that is the gap this ADR
closes.

We deliberately do not add a `MediAccount`/`MediUser` mirror table. A portal
account maps to exactly one CRM `Contact`; the raw payload lives in
`ProviderEvent` for replay (§21 data-minimisation), and the Contact carries the
normalised identity. The dedupe key (lowercased email, E.164 phone) is the same
key the lead funnel (ADR 0023) and the call resolver (`from-call.ts`, §10) match
on, so once a Medi contact exists, those channels find and annotate it for free.

## Decision

A thin receiver + an idempotent async worker, reusing the existing lead/call
machinery rather than rebuilding it.

1. **`POST /api/contacts`** (`apps/web/app/api/contacts/route.ts`) — matches the
   URL the portal already targets. Authenticates by `Bearer` token
   (`MEDI_SYNC_TOKEN`, falling back to the shared `LEAD_WEBHOOK_BEARER_TOKEN` /
   `LEAD_WEBHOOK_TOKEN`); **fails closed** when no token is configured (§8).
   Persists the raw payload to `ProviderEvent` (`provider='medi'`, idempotent on
   `<event>:<mediUserId>`) and enqueues `medi/account.received`. Returns 200 fast
   (§7). No business logic in the handler.

2. **`medi/account.received`** Inngest worker
   (`packages/jobs/src/medi/process-account.ts`, a cross-cutting function — pure
   db + audit + core, no AI/integration glue). Idempotently:
   - resolves/creates the **account-holder Contact** via the new
     `resolveOrCreateContactForMediAccount` (`packages/core/src/contact/from-medi.ts`)
     — keyed on **email first**, phone second; reuse + backfill blanks (never
     overwrite, §3); ambiguity reuses the oldest and flags `triageRequired`
     (never auto-merge, §41.1);
   - writes a **`note` Interaction**: "Imported from the Medi Platform — the
     Medic Mind UCAT portal." (deterministic id → replay-safe);
   - if the signup named a parent/student counterpart, resolves/creates that
     Contact too and adds a reciprocal `parent_of`/`child_of` `ContactLink`;
   - marks the `ProviderEvent` processed and writes a `medi.account_synced`
     audit row.

3. **No board card / no pipeline stage.** The worker only ever touches
   `Contact`, `Interaction(note)`, and `ContactLink`. This is the difference from
   the lead funnel (ADR 0023), which *does* drop a card onto "New leads".

4. **Contact kind** is set from the portal's **self-declared role**
   (student → `student`, parent → `parent`, teacher → `other`; unknown →
   `unclassified`) only on create — real data the person gave us, not a guess,
   and existing contacts keep their own kind.

5. **Durability on the portal side.** A `users.crm_synced_at` column + an admin
   `POST /api/admin/crm/resync` walk re-send any account the portal never
   confirmed (registered before the integration existed, or while the CRM was
   briefly down). Re-sends dedupe on the same `ProviderEvent` key, so a resync is
   safe and converges.

Pure logic (`normaliseMediAccount`, `decideMediMatch`) is unit-tested; the
resolver mirrors `from-call.ts` so the two onboarding channels stay consistent.

## Consequences

- The two products stay in step with no new third-party glue and no duplicate
  customer list — `ProviderEvent` + `Contact` only, no schema migration in the
  CRM.
- "Doesn't add more duplicates" is satisfied structurally: the Medi contact is
  stored under the exact email/phone keys the lead + call paths already match, so
  a later enquiry/call annotates it. The reverse also holds — a Medi import that
  arrives after a lead/call created the contact matches that record.
- Ambiguous identity (shared family line, pre-existing duplicates) never
  auto-merges; it surfaces `triageRequired` for a human.
- Future `user.updated` events can ride the same endpoint (the normaliser is
  tolerant); they would need their own `ProviderEvent` keying (content hash)
  rather than the once-per-user registration key used today.
