// Mandatory MFA-enrolment policy (CLAUDE.md §20, ADR 0010/0014).
//
// 2FA at sign-in is fully implemented (TOTP + recovery codes, `totp.ts` and
// the authorize() gate in `index.ts`); this module decides WHO must have it
// ENROLLED before they can use the CRM. Pure and edge-safe so the middleware
// stays thin and the policy is unit-testable.
//
// Enforcement mode comes from MANDATORY_MFA_ENABLED:
//   - 'true'           → enforced for the privileged roles (§20: CEO, Senior
//                        Manager, Manager — the people who can move money or
//                        manage other users)
//   - 'all'            → enforced for EVERY staff role
//   - unset / 'false'  → off. Enrolment stays voluntary; the sign-in TOTP
//                        gate still applies to anyone who has enrolled.
//
// Default is OFF at the operator's request (they cannot set Railway env vars
// yet, so a default-on gate would lock the team into the setup flow with no
// escape hatch). Flip MANDATORY_MFA_ENABLED=true (or 'all') once the env is
// editable — the §20 target state remains mandatory for privileged roles.

export type MfaEnforcementMode = 'privileged' | 'all' | 'off'

/** Roles required to enrol before they can use the CRM. Canonical names per
 *  ADR 0014 plus the legacy aliases retained in the Postgres enum, so a row
 *  that has not yet been migrated still triggers the gate. */
export const PRIVILEGED_ROLES: ReadonlySet<string> = new Set([
  // canonical (ADR 0014)
  'ceo',
  'senior_manager',
  'manager',
  // legacy aliases (CLAUDE.md §19 forward-only)
  'super_admin',
  'admin',
  'ops_manager',
  'finance',
  'dsl',
])

export function resolveMfaEnforcementMode(envValue: string | undefined): MfaEnforcementMode {
  const v = envValue?.trim().toLowerCase()
  if (v === 'true') return 'privileged'
  if (v === 'all') return 'all'
  return 'off' // unset / 'false' / anything else → enforcement paused
}

export function isPrivilegedRole(
  roles: readonly string[] | undefined,
  primary: string | undefined,
): boolean {
  if (Array.isArray(roles) && roles.some((r) => PRIVILEGED_ROLES.has(r))) return true
  if (primary && PRIVILEGED_ROLES.has(primary)) return true
  return false
}

/** Paths a not-yet-enrolled user must still reach: the setup page itself,
 *  the forced password change, and sign-out. */
const MFA_EXEMPT_PATHS = new Set(['/account/setup-2fa', '/account/change-password'])

export function isMfaExemptPath(pathname: string): boolean {
  if (MFA_EXEMPT_PATHS.has(pathname)) return true
  // NEVER redirect an API/data request to an HTML page: the client expects
  // JSON and surfaces "Unexpected token '<' … not valid JSON". This includes
  // /api/trpc (which the setup-2fa page itself needs to enrol), /api/auth,
  // and the healthcheck. The enrolment gate is a page-navigation nudge; API
  // authorisation is enforced server-side by the tRPC procedures (§20).
  if (pathname.startsWith('/api/')) return true
  return false
}

export interface MfaEnrolmentInput {
  mode: MfaEnforcementMode
  roles: readonly string[] | undefined
  role: string | undefined
  totpEnabled: boolean
  pathname: string
}

/**
 * True when the signed-in user must be redirected to /account/setup-2fa
 * before doing anything else. The caller has already established there IS a
 * session and the path is not public.
 */
export function mfaEnrolmentRequired(input: MfaEnrolmentInput): boolean {
  if (input.mode === 'off') return false
  if (input.totpEnabled) return false
  if (isMfaExemptPath(input.pathname)) return false
  if (input.mode === 'all') return true
  return isPrivilegedRole(input.roles, input.role)
}
