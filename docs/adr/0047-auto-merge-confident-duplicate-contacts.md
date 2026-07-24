# ADR 0047 — Automatic merging of confident duplicate contacts

Date: 2026-07-20
Status: accepted
Amends: the §3/§35/§41.1 "never auto-merge contacts; AI suggests, humans confirm"
golden rule — a single, tightly-scoped exception.

## Context

The CRM already deduplicates at ingestion (lead funnel, call resolver, Medi
sync — all match on lowercased email / last-9-digit phone before creating a
Contact) and offers a manual `/contacts/duplicates` review page. Duplicates
still accumulate from paths that don't dedupe as tightly: manual data entry,
the Trengo history import, call auto-create on a shared line, bulk imports.

The manual page required a human to confirm every merge. The operator's
position (2026-07): for duplicates that are *obviously* the same person, that
confirmation step is pure friction — "just automate it." Merging is destructive
and historically the reason we forbade auto-merge, so the automation has to be
scoped to cases where being wrong is essentially impossible.

## Decision

Introduce automatic merging, scoped to **confident same-person** duplicates
only. Everything else keeps the human-in-the-loop behaviour unchanged.

### What counts as "confident"

Within a raw duplicate cluster (union-find over shared email OR last-9 phone),
we build a second graph whose edges are only the *confident* signals:

- a **shared normalised email** (near-certain: a re-enquiry, a second record for
  the same inbox); or
- a **shared phone AND a matching name** (a shared family landline alone is NOT
  enough — §41.1 — two different people can share it, so the name must agree).

We keep only the component containing the **survivor** (the oldest contact, so
the longest-lived record and its history survive). Members not confidently
connected to the survivor — most importantly a phone-only match with a different
name — are left out and continue to surface on `/contacts/duplicates` for a
human. Pure decision: `planAutoMerges` in `packages/core/src/contact/duplicates.ts`
(unit-tested, including the family-landline non-merge).

### How it runs

- Shared service `apps/web/lib/services/auto-merge-duplicates.ts` loads candidate
  contacts oldest-first, runs `planAutoMerges`, and executes each plan through
  the existing audited `mergeContacts`. It **skips (never fails)** on a
  restricted-access conflict (§41.1) or a race, leaving that pair for a human.
- Hourly cron `contacts/auto-merge-duplicates`
  (`apps/web/app/api/inngest/_boundary/auto-merge-duplicates.ts`) runs it
  unattended with a `system:` actor. Self-healing: any duplicate created between
  runs is folded in on the next tick. Disable with `CONTACTS_AUTO_MERGE=off`.
- Manager+ "Run auto-merge now" button on `/contacts/duplicates`
  (`contact.duplicates.autoMergeNow`) runs the same logic immediately.

### Safety properties (why this is acceptable)

- **Audited**: every merge writes a `contact.merged` AuditLogEntry (`auto:true`),
  same as a manual merge (§5/§20).
- **Bounded**: the scan is capped and there's a per-run merge backstop.
- **Never destroys history**: `mergeContacts` re-parents Interactions,
  FamilyMembers, and Family billing pointers onto the survivor before
  soft-deleting the loser — nothing is hard-deleted (§19).
- **Restricted-access safe**: the DSL-conflict guards in `mergeContacts` still
  hard-throw; the unattended job catches and skips rather than forcing a merge.

## Amendment (2026-07): widen to every cluster + Inngest-independent drain

Two changes after the operator ran this in production:

1. **Merge every cluster, no manual review.** The confident-only scoping above
   is superseded by an operator decision: `planAutoMerges({ includeAmbiguous:
   true })` merges the WHOLE duplicate cluster (any contacts sharing an email or
   a phone) into its oldest member with no human step — including the phone-only/
   different-name case (a possible shared family landline, §41.1). Nothing is
   parked for review; `CONTACTS_AUTO_MERGE=off` is the only control.

2. **Self-drain on page open (Inngest-independent).** On self-hosted Inngest the
   hourly `contacts/auto-merge-duplicates` cron often doesn't fire, so the
   backlog sat and `/contacts/duplicates` kept (wrongly) prompting a manual
   merge — the automation looked "off". Fix, mirroring the Slack-mentions tray:
   `contact.duplicates.drainNow` runs the SAME merge synchronously in the
   request, in bounded ~400-merge chunks, and the page auto-loops it on mount
   until a pass merges nothing. So opening the page clears the whole backlog with
   no human step and no cron dependency; the cron stays as the background
   backstop. `drainNow` respects `CONTACTS_AUTO_MERGE=off` (paused → fall back to
   the manual per-group merge). The explicit `autoMergeNow` trigger ignores the
   kill-switch (a human asked to merge). The page is now normally empty and never
   asks for review — the manual UI only appears when automation is paused or a
   group genuinely can't be auto-merged (a restricted-access conflict).

## Consequences

- The §3/§35/§41.1 wording is updated in the same change to record this single
  exception. The blanket "never auto-merge" no longer holds; "never auto-merge
  *ambiguous* contacts" does.
- Money, charging, deletion, and message-sending remain human-confirmed — this
  ADR does not loosen any of those.
- If a false auto-merge is ever observed, tighten `planAutoMerges` (the one
  decision point) or set `CONTACTS_AUTO_MERGE=off` to fall back to fully-manual.
