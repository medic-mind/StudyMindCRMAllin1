// Audit log writer. Append-only. See CLAUDE.md Section 20 and 21.
// Every write that touches Contact, FinancialAccount, or safeguarding fields
// MUST go through writeAuditLogEntry.

export type { AuditTarget, WriteAuditLogEntryInput, DbClient, WithAuditCtx, AuditingTx } from './writer.js'
export { writeAuditLogEntry, withAudit } from './writer.js'
export { jsonDiff } from './diff.js'
export type { JsonDiffEntry } from './diff.js'

// Back-compat alias used by the tRPC builder ctx. The audit middleware passes
// the actor and request id from ctx; callers supply only the action, target,
// and before/after.
export type AuditLogInput = Omit<
  import('./writer.js').WriteAuditLogEntryInput,
  'actorId' | 'requestId'
>
