# Two-factor authentication (Google Authenticator) — staff tutorial + ops runbook

StudyMind CRM standardises on **Google Authenticator** for two-factor
authentication (2FA). Under the hood this is standard TOTP (RFC 6238) via
`otplib`, so other authenticator apps (1Password, Authy, Microsoft
Authenticator) also work — but Google Authenticator is what we document,
support, and tell staff to install.

Status: 2FA is **available to everyone and currently voluntary**. The
mandatory-enrolment gate exists but is paused (see "Enforcement" below).

---

## Part 1 — Staff tutorial: turning 2FA on (~2 minutes)

The in-app wizard at **Account → Set up two-factor authentication**
(`/account/setup-2fa`) walks through these same four steps:

### 1. Install Google Authenticator on your phone

- iPhone: App Store → search "Google Authenticator" (publisher: Google).
- Android: Google Play → search "Google Authenticator".

The app is free, needs no account, and works offline (it does not need
signal to generate codes).

### 2. Add StudyMind CRM to the app

1. In the CRM, open **Account → Set up two-factor authentication**.
2. In Google Authenticator, tap the **+** button (bottom right).
3. Choose **Scan a QR code**.
4. Point your camera at the QR code on the CRM page.

A new entry called **StudyMind CRM** appears in the app, showing a 6-digit
code that changes every 30 seconds.

**Can't scan?** Choose **Enter a setup key** instead. Account name = your
work email; Key = the setup key shown under "Can't scan?" on the CRM page;
Type = **Time based**.

### 3. Verify

Type the 6-digit code from the app into the CRM page and press **Verify and
enable**. This proves the pairing works before 2FA switches on. If the code
rolls over while you type, enter the new one — the server also accepts the
immediately-previous code, so slight clock drift is fine.

### 4. Save your recovery codes

The CRM shows **10 one-time recovery codes, exactly once**. Copy or download
them and store them in your password manager (or print them). If you lose
your phone, a recovery code is the only self-service way back in.

### Signing in from then on

Sign-in becomes two steps: email + password, then the 6-digit code from
Google Authenticator. Lost the phone? Click **"Lost your phone? Use a
recovery code"** on the code screen and enter one of your saved codes (each
works once).

### Turning it off / moving to a new phone

- **Turn off**: Account → Disable two-factor authentication. Requires your
  password AND a current code (or a recovery code).
- **New phone**: sign in (using the old phone or a recovery code), disable
  2FA, then re-run setup on the new phone. Google Authenticator's own
  transfer feature (Settings → Transfer accounts) also moves the StudyMind
  entry across directly.

---

## Part 2 — Ops runbook

### Enforcement (currently paused)

The mandatory-enrolment policy lives in `apps/web/lib/auth/mfa-policy.ts`
and is driven by the `MANDATORY_MFA_ENABLED` env var on the `web` service:

| Value            | Behaviour |
|------------------|-----------|
| unset / `false`  | **Current state.** Enrolment voluntary; anyone enrolled is still TOTP-gated at sign-in. |
| `true`           | CEO / Senior Manager / Manager (+ legacy aliases) are redirected to `/account/setup-2fa` until they enrol. |
| `all`            | Every staff role must enrol. |

The gate never intercepts `/api/*` requests (redirecting a JSON caller to an
HTML page surfaces as "Unexpected token '<' … is not valid JSON" — this bit
us once; there is a regression test). Rollout advice: announce first, then
set `true`, then `all` once managers are enrolled.

### Lost phone AND lost recovery codes

There is deliberately **no admin "reset 2FA" button**. Self-service recovery
is: recovery code → sign in → disable → re-enrol. If a user has neither
phone nor codes, an operator with database access must clear the user's
`totpSecretCipherId` + `totpEnabledAt` and delete their `TotpRecoveryCode`
rows — treat that as a break-glass action: verify identity out-of-band
first, and record who asked/approved (the change itself is visible in the
audit trail).

### Implementation map

| Piece | Where |
|---|---|
| TOTP + recovery-code crypto | `apps/web/lib/auth/totp.ts` (otplib; 30 s step, ±1 window; 10 × 10-char codes, sha256 at rest) |
| Sign-in gate | `authorize()` in `apps/web/lib/auth/index.ts` (`TOTP_REQUIRED` → second sign-in step) |
| Enrolment wizard | `apps/web/app/(app)/account/setup-2fa/` (4-step Google Authenticator tutorial) |
| Disable flow | `apps/web/app/(app)/account/disable-2fa/` (password + code) |
| Mandatory-enrolment policy | `apps/web/lib/auth/mfa-policy.ts` (+ middleware), unit-tested |
| Secret storage | `EncryptedField` KMS envelope (`User.totpSecretCipherId`); never plaintext, never logged |
| QR issuer label | "StudyMind CRM" (set in `account.totp.beginSetup`) |
