# StudyMind CRM — Security, Audit & GDPR: Final Report

**Prepared for:** Becca
**Date:** 24 July 2026
**Author:** Engineering
**Status of code:** delivered on branch `claude/crm-security-compliance-amp18m`,
1 commit ahead of `main`, full automated quality gate green.

> Full evidence (every questionnaire answer with the mechanism behind it) is in
> the companion file `docs/compliance/security-and-data-protection.md`.

---

## 1. Headline

You asked for two things: **(1)** a way to see who did what to each CRM entry —
including edits to contacts, B2B accounts and schools — and **(2)** a full GDPR
system to permanently erase records. **Both are built, tested, and ready.** While
doing it we also found and fixed a real security defect (a hard-coded default
admin password).

**Is everything ready?** The two requested features are **ready to ship**. **Full
regulatory compliance is substantially advanced but not 100% complete** — a short
list of items remains, several of which are organisational rather than code (see
§5). This report tells you exactly what is done and what is left, so nothing is
overstated.

---

## 2. What is DONE (built, tested, verified)

### 2.1 "Who did what" — a complete, viewable activity trail
- **Record views are now logged** (`contact.viewed`, `business_account.viewed`) on
  top of the edits, deletions and sign-ins already recorded.
- **Per-record Activity log** on every **contact** and every **B2B account / school**
  — plain-English "who viewed / added / edited / deleted this, and when", with the
  changed fields shown for edits.
- **Organisation-wide audit page** at the **Audit log** nav section — searchable by
  activity type (views, changes, sign-ins, exports, DSAR exports) and date range.
- **Sign-ins, failed logins and lockouts** surface in the viewer (with device/IP).
- **CSV exports are now recorded** (who, which list, row count, filter) — previously
  a bulk export left no trace.
- **Access-controlled:** all activity views are CEO / Senior Manager / Manager only,
  enforced on the server.

### 2.2 GDPR right-to-erasure — a full system
- **"Erase (GDPR)"** on each contact (CEO / Senior Manager, retype-to-confirm) with
  two modes:
  - **Schedule erasure** — soft-delete + **30-day reversible grace window**.
  - **Erase now** — immediate and permanent.
- **What it destroys:** name, contact details, date of birth, address, notes, and the
  content of messages/calls are overwritten/removed; encrypted fields are
  crypto-shredded (keys destroyed); extra contact points and guardian/bill-payer
  details are deleted. The person can no longer be identified.
- **Automatic completion:** a new **daily job** permanently completes any scheduled
  erasure once its 30-day window elapses.
- **Fully audited:** scheduling, cancelling and completing an erasure are recorded.

### 2.3 Security fix — hard-coded default password removed
- The initial-admin seed no longer contains any hard-coded password and no longer
  overwrites an existing password on deploy. On first setup it generates a strong
  random password (shown once) and forces a first-login change; recovery is behind an
  explicit flag.

### 2.4 Documentation
- `docs/compliance/` (previously empty) now holds the full evidence-based
  questionnaire answers and this report.

---

## 3. What was ALREADY strong (confirmed by code review)

| Area | Status |
|---|---|
| Self-hosted, entirely behind a login wall (not publicly reachable, not on claude.ai) | ✅ |
| Individual accounts, bcrypt passwords, mandatory 2FA (Google Authenticator) | ✅ |
| Role-based permissions, enforced server-side | ✅ |
| Immediate access revocation when staff leave (+ session kill) | ✅ |
| HTTPS everywhere, HSTS, hardened security headers, strict CSP | ✅ |
| Secrets (email/comms/payment tokens, 2FA) encrypted with AES-256 (KMS envelope) | ✅ |
| DSAR export — everything held on a client, as a signed ZIP | ✅ |
| Data minimisation on ingest (raw payloads kept separate) | ✅ |
| Backups (Railway point-in-time recovery) + disaster-recovery runbook | ✅ |
| No real client data used in build/testing | ✅ |

---

## 4. Verification

All changes passed the full automated gate before shipping:
**type-checking · linting · 2,054 tests passing · permission-policy drift check.**
New logic (erasure engine, audit view-model, erasure-scheduling job, hardened seed)
ships with its own unit tests.

---

## 5. What remains for FULL compliance (honest list)

None of these block the two features above; they are the gap between "the requested
work is done" and "we can tell an auditor we are fully compliant." Several are not
code:

1. **Independent penetration test** — none has been done. Commission one. *(external)*
2. **Database-at-rest encryption** — client PII relies on the hosting provider's disk
   encryption, not app-level encryption. Get written confirmation from Railway that
   the production database volume is encrypted. *(attestation)*
3. **Per-category retention** — the 30-day erasure job is live; the broader
   "delete emails after 7 years, recordings after 90 days" engine exists but is not
   yet scheduled. *(code — small)*
4. **Restrict bulk export** — any staff member can export a contact list (now logged);
   consider gating to Manager+ and adding an off-switch. *(code — small)*
5. **Fill in `OWNERS.md`** — Data Protection Officer, Designated Safeguarding Lead,
   product owner and cloud-account owners are still placeholders. *(organisational)*
6. **Session idle-timeout** — sessions last up to 12 hours; add a ~30-minute
   inactivity timeout. *(code — small)*
7. **DSAR download button** — the export works but is triggered by URL; add a button.
   *(code — small)*

---

## 6. Deployment status & next step

- The code is on branch `claude/crm-security-compliance-amp18m` (1 commit ahead of
  `main`), working tree clean, gate green.
- It is **not yet on `main`** and therefore **not yet deployed to production** —
  merging to `main` auto-deploys.
- The database migration (two nullable columns + an index for the erasure feature)
  applies automatically on the next production deploy.
- **Before the next deploy:** confirm `SUPER_ADMIN_PASSWORD` is set in Railway (the
  old default is gone, so the CEO password will no longer be reset on deploy).

**Verdict:** the audit-trail and GDPR-erasure systems you asked for are complete,
verified, and ready to deploy. Full compliance needs the seven items in §5, of which
four are small code tasks and three are organisational/external.
