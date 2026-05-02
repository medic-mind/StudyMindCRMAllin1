// Audit log writer. Append-only. See CLAUDE.md Section 20 and 21.
// Every write that touches Contact, FinancialAccount, or safeguarding fields
// MUST call writeAuditLogEntry.

export interface AuditLogInput {
  action: string
  actorId: string | null
  targetType: string
  targetId: string
  requestId?: string
  purpose?: string
  before?: unknown
  after?: unknown
}

export interface AuditWriter {
  write(input: AuditLogInput): Promise<void>
}

export async function writeAuditLogEntry(_input: AuditLogInput): Promise<void> {
  // Skeleton — real implementation persists to AuditLogEntry via @studymind/db.
  throw new Error('not implemented')
}
