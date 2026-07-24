# StudyMind CRM — Security, Audit & GDPR: Implementation Report

**Prepared for:** Becca
**Date:** 24 July 2026
**Scope:** Review of the CRM against the security & data-protection questionnaire,
plus the accountability (audit) and GDPR-erasure work delivered this week.

---

## 1. Summary

We reviewed the StudyMind CRM in depth against the security and data-protection
questions and verified every answer against the actual code. The system was
already strong on the fundamentals — it is a self-hosted application behind a
full login wall, with individual accounts, mandatory two-factor authentication,
role-based permissions, encrypted secrets, HTTPS everywhere, and an append-only
record of changes.

The two genuine gaps the team had identified were confirmed and **have now been
fixed**:

1. **"We have no log of who did what for each CRM entry."** Correct in practice —
   the underlying data was being recorded, but there was no screen to see it, and
   *viewing* a record wasn't logged. We have now built a complete, viewable
   activity trail (per record and organisation-wide).
2. **GDPR erasure.** There was no way to permanently erase a client's personal
   data on request. We have now built a full erasure system (immediate and
   scheduled), with a 30-day grace window and automatic completion.

We also found and fixed a real security defect (a hard-coded default administrator
password) as part of this work.

Everything below has passed the full automated quality gate (type-checking,
linting, 2,054 tests, and permission-policy checks).

---

## 2. What we delivered this week

### A. A complete, viewable audit trail ("who did what")

- **Per-record activity log.** Every contact record — and every B2B account and
  school — now has an **"Activity log" / "Access & change log"** section showing,
  in plain English, who **viewed**, **added**, **edited**, or **deleted** it, and
  exactly when. Edits show which fields changed.
- **Record views are now logged.** Previously only edits/deletions and views of a
  child's record were recorded; ordinary record *views* are now captured too, so
  "who looked at this family's record" is answerable.
- **Organisation-wide audit page.** A new **Settings → Audit log** page lets a
  manager search all activity by type (record views, changes, sign-ins, exports,
  DSAR exports) and by date range — e.g. "what did this person do last week?"
- **Sign-ins are surfaced.** Successful logins (with device/IP), failed attempts,
  and lockouts already fed the audit trail and now appear in the viewer.
- **Exports are now recorded.** Downloading a contact or account list to a
  spreadsheet is logged (who, which list, how many rows, what filter) — previously
  a bulk export left no trace.
- **Access is controlled.** The activity views are visible only to CEO, Senior
  Manager, and Manager, enforced on the server.

### B. A full GDPR right-to-erasure system

- **"Erase (GDPR)" on every contact** (CEO / Senior Manager only), with a
  retype-to-confirm step for safety. Two options:
  - **Schedule erasure** — soft-deletes with a **30-day grace window** (reversible
    until then; a data-entry mistake can be undone).
  - **Erase now** — immediate, permanent.
- **What erasure does.** It permanently destroys the person's personal data:
  name, contact details, date of birth, address, notes, and the content of their
  messages/calls are overwritten/removed, any encrypted fields are
  crypto-shredded (their keys destroyed), and extra contact points and
  guardian/bill-payer details are deleted. The person can no longer be identified.
- **Automatic completion.** A new daily job permanently completes any erasure
  whose 30-day grace window has elapsed — the "automatic deletion setting" the
  questionnaire asks about.
- **Fully audited.** Scheduling, cancelling, and completing an erasure are all
  recorded in the audit trail.

### C. Security fix — hard-coded default password removed

The initial-administrator seed used to contain a hard-coded fallback password and
re-applied it on **every** deployment. We rewrote it so it:

- ships **no** hard-coded password (it generates a strong random one on first
  setup, shown once, with a forced first-login change);
- **never overwrites** an existing administrator's password on later deployments;
- only ever resets an existing password behind an explicit, deliberate recovery
  flag.

### D. Compliance documentation

The full, evidence-based answers to the security questionnaire are now stored in
the repository at `docs/compliance/security-and-data-protection.md` — a durable,
version-controlled record (this folder was previously empty).

---

## 3. Current posture at a glance

| Area | Status |
|---|---|
| Behind a login wall; not publicly reachable | ✅ Strong |
| Individual logins, bcrypt, mandatory 2FA | ✅ Strong |
| Role-based permissions (server-enforced) | ✅ Strong |
| Immediate access revocation when staff leave | ✅ Strong |
| Audit trail of changes, sign-ins **and now views** | ✅ Strong (new) |
| Viewable per-record + org-wide activity | ✅ Delivered this week |
| HTTPS/HSTS + hardened security headers | ✅ Strong |
| Secrets encrypted (KMS envelope) | ✅ Strong |
| DSAR export (everything on a client) | ✅ Available |
| GDPR permanent erasure + auto-deletion | ✅ Delivered this week |
| Data minimisation on ingest | ✅ In place |
| Backups (Railway PITR) + DR runbook | ✅ In place |
| Hard-coded default password | ✅ Removed this week |

---

## 4. Honest gaps & recommended next steps

These are not blockers, but they should be on the roadmap — especially ahead of
any Local Authority / school contract:

1. **Independent penetration test.** None has been done; commission one.
2. **Database-at-rest encryption.** Personal data (names, phones, etc.) relies on
   the hosting provider's disk encryption, not application-level encryption.
   Obtain written confirmation from Railway that the production database volume is
   encrypted at rest.
3. **Per-category retention.** The 30-day erasure job is live; the broader
   "delete emails after 7 years, recordings after 90 days" engine exists but isn't
   yet scheduled — turn it on.
4. **Restrict bulk export.** Any staff member can export a contact list; consider
   limiting export to Manager+ and adding an off-switch. (Exports are now logged
   regardless.)
5. **Fill in `OWNERS.md`.** The named owners (Data Protection Officer,
   Designated Safeguarding Lead, product owner, cloud-account owners) are still
   placeholders — important for continuity.
6. **Session idle-timeout.** Sessions currently last up to 12 hours; add a
   ~30-minute inactivity timeout.
7. **DSAR download button.** The DSAR export works but is triggered by URL; add a
   button on the contact page.

---

## 5. Assurance

All changes were verified against the full automated gate before shipping:
type-checking, linting, the complete test suite (**2,054 tests passing**), and the
permission-policy drift check. New logic (the erasure engine, the audit
view-model, the erasure-scheduling job, and the hardened seed) ships with its own
unit tests.

*Questions on any of the above can go to the engineering team.*
