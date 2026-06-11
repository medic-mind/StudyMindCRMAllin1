// Per-procedure rate limits for tRPC. CLAUDE.md §27.
//
// Limits are tuned per-action class, not per-user. Reads are cheap and many,
// writes are stricter, sensitive writes are very strict. The limits are
// applied as a sliding window keyed by (userId, procedurePath) — see
// `apps/web/lib/trpc/rate-limit.ts` for the runtime store.
//
// New procedures fall back to DEFAULT_LIMIT until they are listed here.
// Add an entry rather than relying on the default for any new sensitive path.

export interface RateLimit {
  /** Window length in seconds. */
  windowSec: number
  /** Maximum requests allowed per window. */
  max: number
}

export const DEFAULT_READ_LIMIT: RateLimit = { windowSec: 60, max: 60 }
export const DEFAULT_WRITE_LIMIT: RateLimit = { windowSec: 60, max: 10 }
export const SENSITIVE_WRITE_LIMIT: RateLimit = { windowSec: 60, max: 5 }
export const DEFAULT_LIMIT: RateLimit = DEFAULT_READ_LIMIT

/**
 * Per-procedure overrides. Keys are the dotted tRPC path
 * (e.g. `'finance.refund.create'`). Anything not listed uses the read default.
 */
export const RATE_LIMITS: Readonly<Record<string, RateLimit>> = {
  // Sensitive money / role-grant / DSAR procedures
  'finance.refund.create': SENSITIVE_WRITE_LIMIT,
  'finance.paymentLink.create': SENSITIVE_WRITE_LIMIT,
  'finance.subscription.cancel': SENSITIVE_WRITE_LIMIT,
  'admin.user.role.grant': SENSITIVE_WRITE_LIMIT,
  'admin.user.role.revoke': SENSITIVE_WRITE_LIMIT,
  'admin.user.invite': SENSITIVE_WRITE_LIMIT,
  'admin.user.deactivate': SENSITIVE_WRITE_LIMIT,
  'admin.secrets.rotate': SENSITIVE_WRITE_LIMIT,
  'compliance.dsar.export': SENSITIVE_WRITE_LIMIT,

  // Standard writes
  'contact.create': DEFAULT_WRITE_LIMIT,
  'contact.update': DEFAULT_WRITE_LIMIT,
  'family.merge': DEFAULT_WRITE_LIMIT,
  'family.update': DEFAULT_WRITE_LIMIT,
  'interaction.create': DEFAULT_WRITE_LIMIT,
  'interaction.delete': DEFAULT_WRITE_LIMIT,
  'task.create': DEFAULT_WRITE_LIMIT,
  'task.update': DEFAULT_WRITE_LIMIT,
  'finance.discrepancy.resolve': DEFAULT_WRITE_LIMIT,
  'auth.changePassword': SENSITIVE_WRITE_LIMIT,
  // AI Knowledge assistant — each call carries the full knowledge base as
  // model context, so it is priced like a write even though it mutates
  // nothing (ADR 0040).
  'knowledge.ask': DEFAULT_WRITE_LIMIT,
  // Knowledge AI editor (CEO / Senior Manager). Propose is AI-priced like
  // ask; commit/reset rewrite company-wide reference content.
  'knowledge.edit.propose': DEFAULT_WRITE_LIMIT,
  'knowledge.edit.commit': SENSITIVE_WRITE_LIMIT,
  'knowledge.edit.reset': SENSITIVE_WRITE_LIMIT,

  // Reads
  'contact.list': DEFAULT_READ_LIMIT,
  'contact.get': DEFAULT_READ_LIMIT,
  'family.list': DEFAULT_READ_LIMIT,
  'family.get': DEFAULT_READ_LIMIT,
  'interaction.list': DEFAULT_READ_LIMIT,
  'finance.list': DEFAULT_READ_LIMIT,
  'finance.discrepancy.list': DEFAULT_READ_LIMIT,
  'audit.list': DEFAULT_READ_LIMIT,
}

/** Returns the limit for a procedure path, falling back to the default. */
export function getRateLimit(procedurePath: string): RateLimit {
  return RATE_LIMITS[procedurePath] ?? DEFAULT_LIMIT
}
