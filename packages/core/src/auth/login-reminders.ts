// Automated "please finish signing in" reminders (ADR 0021 amendment). Pure
// decision logic: given a staff account that was created but has never signed
// in, decide whether it's due another nudge. The boundary cron queries
// candidates and sends via the system mailbox; this keeps the policy testable
// and deterministic (`now` injected, no I/O).

export interface LoginReminderConfig {
  /** Grace period after account creation before the first nudge. */
  firstReminderAfterDays: number
  /** Days between nudges. */
  cadenceDays: number
  /** Hard cap on nudges — after this we stop and leave it to a human. */
  maxReminders: number
}

export const DEFAULT_LOGIN_REMINDER_CONFIG: LoginReminderConfig = {
  firstReminderAfterDays: 2,
  cadenceDays: 3,
  maxReminders: 3,
}

const DAY_MS = 24 * 60 * 60 * 1000

export interface LoginReminderCandidate {
  createdAt: Date
  lastSignInAt: Date | null
  lastLoginReminderAt: Date | null
  loginReminderCount: number
}

/**
 * Is this never-signed-in account due another login reminder now? Callers have
 * already filtered to live, non-deactivated accounts that CAN sign in
 * (passwordHash set) but never have.
 */
export function shouldRemindLogin(
  u: LoginReminderCandidate,
  now: Date,
  cfg: LoginReminderConfig = DEFAULT_LOGIN_REMINDER_CONFIG,
): boolean {
  if (u.lastSignInAt) return false
  if (u.loginReminderCount >= cfg.maxReminders) return false
  const sinceCreated = (now.getTime() - u.createdAt.getTime()) / DAY_MS
  if (sinceCreated < cfg.firstReminderAfterDays) return false
  if (u.lastLoginReminderAt) {
    const sinceLast = (now.getTime() - u.lastLoginReminderAt.getTime()) / DAY_MS
    if (sinceLast < cfg.cadenceDays) return false
  }
  return true
}

/** Resolve the config from env overrides, falling back to the defaults. */
export function resolveLoginReminderConfig(env: {
  firstAfterDays?: string | null
  cadenceDays?: string | null
  maxReminders?: string | null
}): LoginReminderConfig {
  const num = (raw: string | null | undefined, fallback: number): number => {
    if (!raw) return fallback
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    firstReminderAfterDays: num(env.firstAfterDays, DEFAULT_LOGIN_REMINDER_CONFIG.firstReminderAfterDays),
    cadenceDays: Math.max(1, num(env.cadenceDays, DEFAULT_LOGIN_REMINDER_CONFIG.cadenceDays)),
    maxReminders: num(env.maxReminders, DEFAULT_LOGIN_REMINDER_CONFIG.maxReminders),
  }
}
