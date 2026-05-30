// Shared inputs for the account welcome / reset email + PDF (ADR 0021).

export interface WelcomeCredentials {
  /** Display name of the new user, if known. */
  name?: string | null
  /** Email address — also the sign-in username. */
  email: string
  /** One-time temporary password the user must change on first sign-in. */
  temporaryPassword: string
  /** Absolute URL of the CRM sign-in page. */
  signInUrl: string
  /** Name (or email) of the administrator who created/reset the account. */
  inviterName?: string | null
  /** True when this is an admin-triggered reset of an existing account. */
  isReset?: boolean
}
