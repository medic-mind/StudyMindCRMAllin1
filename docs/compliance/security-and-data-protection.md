# StudyMind CRM — Security & Data Protection

> Compliance answer set for security / GDPR due-diligence. Every statement is
> grounded in the actual codebase and verified file-by-file. Where the code and
> older internal notes disagreed, this document reflects the **code's reality**.
> Last reviewed: 2026-07-24.

Legend: ✅ implemented · 🟡 partial / caveat · 🔴 gap / recommended follow-up ·
🔧 added or fixed on 2026-07-24.

---

## 1. Hosting & external reachability

| Question | Answer |
|---|---|
| Own web address or claude.ai? | ✅ **Your own.** Self-hosted **Next.js 15** app on **Railway**, served from your own domain (`crm.studymind.co.uk`). Not a Claude artifact, not hosted on claude.ai. |
| Built as an artifact / our hosting / other? | ✅ Our own hosting — a complete application (frontend, backend, database) on infrastructure you control. |
| Ever "published"/"shared" from Claude? Public link? | ✅ No. There is no Claude publish/share surface. |
| Private-window access with no login? | ✅ No. `apps/web/middleware.ts` redirects every non-public path to `/sign-in`. Public paths are the login/reset pages, health check, brand-logo image, and machine-to-machine endpoints authenticated by **signature / token / API key** (payment & comms webhooks, the Inngest worker, lead capture, OAuth callbacks, GoCardless mandate links) — none expose a browsable client record. |
| Could it appear in a Google search? | ✅ No client data — everything is behind the login wall. 🟡 No explicit `noindex`/`robots.txt`; only the login page itself could be indexed (no data on it). |
| Where is data stored, which service, which country? | ✅ **Railway-managed PostgreSQL** + **AWS S3 (eu-west-2, London)** for files. Under your own Railway/AWS accounts. |
| Personal or business account? | Commercial cloud (Railway + AWS). GitHub repo + Railway owned by Mohil & Kunal, private, 2FA-protected (attested). |

**Transport & headers (verified in `apps/web/next.config.mjs` / `lib/security/csp.ts`):** HTTPS enforced with **HSTS** (2-year `max-age`, `includeSubDomains; preload`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` disabling camera/mic/geolocation, and a **strict nonce-based CSP** on scripts. A regression test fails the build if HSTS is removed.

---

## 2. Logging in & who can get in

| Question | Answer |
|---|---|
| Individual accounts or shared password? | ✅ **Individual accounts** — email + per-user **bcrypt (cost 12)** password. No shared-password path. |
| MFA available / on? | ✅ **TOTP 2FA (Google Authenticator) with recovery codes, mandatory-on for every role by default** (`lib/auth/mfa-policy.ts`). First sign-in forces enrolment. 🟡 Can be paused org-wide via `MANDATORY_MFA_ENABLED=off` — recommend leaving it on. |
| Permission levels by role? | ✅ Five roles (CEO, Senior Manager, Manager, Sales Executive, Virtual Assistant) each mapped to an explicit action list (`packages/core/src/auth/policies.ts`), plus custom roles and per-user grants. Enforced **server-side** in every tRPC procedure. |
| Who grants/removes access? | ✅ Account creation + role changes are **CEO / Senior Manager only**; lower roles cannot create a higher one. Every change audited. |
| Immediate disable when staff leave? | ✅ Yes — *deactivate*, *delete*, *permanently delete* (CEO-only hard delete + crypto-shred of their tokens), and *force sign-out* all kill sessions. DB-backed sessions are re-checked each request, so a killed session is dead on the next click. |
| Default / hard-coded passwords? | 🔧 **Fixed today.** The initial-CEO seed previously shipped a hard-coded fallback password and overwrote the CEO password on every deploy. It is now **non-destructive**: it never overwrites an existing password, ships **no** hard-coded default (it generates a strong random one on first bootstrap, printed once), and forces a first-login reset. Recovery is an explicit `SUPER_ADMIN_FORCE_PASSWORD_RESET=true` flag. |
| Other safeguards | ✅ Brute-force lockout after 5 failed attempts; temporary passwords with forced reset; self-service sign-up disabled. 🟡 12-hour absolute session cap; **no idle timeout** (recommended follow-up). |

---

## 3. Audit trail — "who did what for each CRM entry"

The raw data was already captured to an append-only `AuditLogEntry` table; the gap
was that **nothing surfaced it**, and ordinary record *views* weren't logged.
Both are now closed.

| Question | Answer |
|---|---|
| Log of who logged in and when? | ✅ Captured (`auth.signin_succeeded/_failed`, lockouts, 2FA events, with IP + device). 🔧 Now viewable in the **Audit log** nav section. |
| Who viewed/added/edited/deleted a client record? | 🔧 **Now fully captured and viewable.** Adds/edits/deletes were already audited (with before→after diffs); **record views are now logged too** (`contact.viewed` / `business_account.viewed`). A per-record **Activity log** on each contact **and each B2B account/school**, plus an org-wide the **Audit log** nav section, show it in plain English. Gated to CEO / Senior Manager / Manager (`audit.read`). |
| How long kept / exportable? | ✅ Append-only; auto-archived to S3 cold storage at 12 months; exportable per-client via the DSAR export. 🟡 The "7-year then hard-delete" of audit rows isn't enforced in code (rows are kept indefinitely — data not lost). |
| Alerts on unusual activity? | ✅ Weekly UEBA job scans the audit log (failed-login spikes, off-hours DSAR exports) and posts to Slack. |

---

## 4. Downloading & exporting data

| Question | Answer |
|---|---|
| Can users export to a spreadsheet? | ✅ Yes — "Export CSV" on Contacts, Accounts, Invoices, Direct-Debit lists. |
| Which roles / is it recorded? | 🔧 **Exports are now logged** (`contact.exported` / `account.exported`, with row count + active filter) and appear in the audit log. Any signed-in staff member can export (per `contact.read`, held by all roles). |
| Limit / switch off bulk export? | 🟡 Client-side 5,000-row cap on contacts; **recommend** gating export to Manager+ and adding a kill-switch (follow-up). |
| Where does the file go? | To the staff member's device — outside the CRM once downloaded, which is why export logging (today's change) matters. |

---

## 5. Security of the data itself

| Question | Answer |
|---|---|
| Encrypted at rest & in transit? | ✅ **In transit:** TLS/HTTPS + HSTS. **At rest:** *secrets* (Gmail/Trengo/Zoom/invoicing tokens, 2FA secrets) are individually **AES-256-GCM envelope-encrypted** (AWS KMS, or a local key when KMS isn't configured). 🟡 **General client PII (names, emails, phones, DOB, notes) is stored as ordinary DB columns**, protected by the hosting provider's disk encryption — not application field-encryption. Confirm Railway Postgres disk-encryption in writing for auditors. |
| Independent security review? | 🔴 **None on record.** Self-authored threat model + weekly automated anomaly job only. **Recommend commissioning an external penetration test.** |
| How are fixes applied / who's responsible? | ✅ Continuous deployment from GitHub → Railway, gated by CI (typecheck, lint, tests, build, policy checks) + dependency scanning. Owners: Mohil & Kunal (attested). |
| Outside services & what data they see | Gmail, Aircall, Trengo, Slack, Stripe/GoCardless, the booking site, AWS S3, and AI providers (Gemini/OpenAI/Anthropic). AI runs through one seam that strips prompt-injection content and never receives encrypted/safeguarding fields. Each integration sees only its own data. |

---

## 6. Legal rights (GDPR)

| Question | Answer |
|---|---|
| Pull together everything on a client (DSAR)? | ✅ `GET /api/internal/dsar/[contactId]` (CEO/SM) streams a ZIP of every record touching the contact, with a SHA-256 manifest; the export is itself audited. |
| Correct / permanently delete on request? | 🔧 **Correct:** yes (audited edit). **Permanent erasure:** now a full system — an **"Erase (GDPR)"** control (CEO/SM, retype-confirm) that either **schedules erasure with a 30-day grace** (reversible) or **erases immediately**. Erasure crypto-shreds the contact's encrypted fields, deletes supplementary personal data, redacts message/note content, and anonymises the record — permanent and audited (`contact.erased`). |
| Automatic retention/deletion? | 🔧 **New daily job** (`compliance/erase-due-records`) permanently erases contacts once their 30-day grace window elapses. 🟡 The broader per-category retention engine remains available but not yet scheduled (recommended follow-up). |
| Only the info we need (minimisation)? | ✅ Webhooks store the raw payload separately and map only the fields used into working tables. |

---

## 7. Backups, recovery & keys

| Question | Answer |
|---|---|
| Backups — frequency, location, restore tested? | ✅ Railway-managed PostgreSQL with point-in-time recovery; documented DR plan (`docs/runbooks/disaster-recovery.md`, RPO 5 min / RTO 2 h) + reconnect/replay scripts (`scripts/dr/`). 🟡 The "weekly logical dump to S3" is documented but not implemented as a job; **run and record a restore drill.** |
| Recovery time if hosting failed? | ~2 h web / ~4 h full integrations, per the DR runbook. |
| Who owns code/hosting/keys? | Mohil & Kunal — private GitHub + Railway, 2FA (attested); code MIT-licensed, © StudyMind Ltd. 🟡 `OWNERS.md` still has placeholder `<TBD>` entries (product owner, DPO, DSL, account owners) — **fill these in.** |
| Written documentation? | ✅ `CLAUDE.md` (extensive), 43 ADRs, 12 runbooks, API docs. 🔧 This document fills the previously-empty `docs/compliance/`. |

---

## 8. How it was built

| Question | Answer |
|---|---|
| Real client data in build/testing? | ✅ No — tests use sanitised per-provider sample payloads; no real data in fixtures/seeds. |
| Live data entered into AI tools? | Building the software doesn't store client data anywhere. At runtime, AI features route through one controlled seam that minimises/sanitises inputs and excludes encrypted/safeguarding fields, under your own provider accounts. |

---

## Recommended follow-ups (not yet done)

1. 🔴 Commission an independent penetration test.
2. 🟡 Obtain written confirmation of Railway Postgres disk-encryption at rest.
3. 🟡 Schedule the per-category retention engine (email 7y, recordings 90d, etc.).
4. 🟡 Gate CSV export to Manager+ and add an operational kill-switch.
5. 🟡 Fill in `OWNERS.md` (DPO, DSL, product owner, account owners).
6. 🟡 Add a session idle-timeout (e.g. 30 minutes).
7. 🟡 Add a DSAR "download" button in the UI (the export exists; only the URL does today).
