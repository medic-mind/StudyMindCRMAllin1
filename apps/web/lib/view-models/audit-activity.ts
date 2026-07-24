// Audit activity view-model (CLAUDE.md §26 — never send raw rows to the
// client). Turns an append-only AuditLogEntry row into a human-readable
// "who did what, when" line for the compliance activity viewer (per-record
// history tab + the org-wide Settings → Audit log page).
//
// Pure + unit-tested. The tRPC layer batches actor-id → name resolution and
// hands this a lookup map; the mapping of raw `action` strings to friendly
// labels/categories lives here so both surfaces read identically.

export type AuditCategory =
  | 'view'
  | 'create'
  | 'update'
  | 'delete'
  | 'merge'
  | 'auth'
  | 'export'
  | 'export.dsar'
  | 'other'

export interface AuditActor {
  name: string | null
  email: string | null
}

export interface AuditActivityRow {
  id: string
  action: string
  /** Friendly verb, e.g. "Viewed", "Edited", "Created". */
  label: string
  category: AuditCategory
  /** Resolved actor display: a person's name/email, or "System". */
  actorLabel: string
  actorId: string | null
  purpose: string | null
  /** Top-level fields that changed on an update, for a compact "changed: …". */
  changedFields: string[]
  occurredAt: string
}

interface ActionMeta {
  label: string
  category: AuditCategory
}

// Explicit map for the actions we surface most; everything else falls back to
// a prettified form of the raw name so nothing is ever unlabelled.
const ACTION_META: Record<string, ActionMeta> = {
  'contact.viewed': { label: 'Viewed', category: 'view' },
  'contact.read_minor': { label: 'Viewed (minor)', category: 'view' },
  'contact.created': { label: 'Created', category: 'create' },
  'contact.updated': { label: 'Edited', category: 'update' },
  'contact.merged': { label: 'Merged', category: 'merge' },
  'contact.deleted': { label: 'Deleted', category: 'delete' },
  'contact.bulk_soft_deleted': { label: 'Deleted', category: 'delete' },
  'contact.restored': { label: 'Restored', category: 'create' },
  'contact.exported': { label: 'Exported (CSV)', category: 'export' },
  'account.exported': { label: 'Exported (CSV)', category: 'export' },
  'dsar.exported': { label: 'DSAR export', category: 'export.dsar' },
  'auth.signin_succeeded': { label: 'Signed in', category: 'auth' },
  'auth.signin_failed': { label: 'Failed sign-in', category: 'auth' },
  'auth.account_locked': { label: 'Account locked', category: 'auth' },
  'auth.totp_failed': { label: 'Failed 2FA code', category: 'auth' },
  'auth.recovery_code_used': { label: 'Recovery code used', category: 'auth' },
  'auth.sessions_revoked_by_admin': { label: 'Signed out (by admin)', category: 'auth' },
  'auth.user_erased': { label: 'Account erased', category: 'delete' },
  'auth.role_granted': { label: 'Role granted', category: 'update' },
  'auth.role_revoked': { label: 'Role revoked', category: 'update' },
}

/** Prettify a raw dotted action into a Sentence-case fallback label. */
function prettifyAction(action: string): string {
  const tail = action.includes('.') ? action.slice(action.indexOf('.') + 1) : action
  const words = tail.replace(/_/g, ' ').trim()
  if (!words) return action
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function categoriseFallback(action: string): AuditCategory {
  if (action.startsWith('auth.')) return 'auth'
  if (/(created|added)$/.test(action)) return 'create'
  if (/(deleted|removed|archived|erased)$/.test(action)) return 'delete'
  if (/(updated|changed|moved|assigned|edited)$/.test(action)) return 'update'
  if (/export/.test(action)) return 'export'
  if (/(viewed|read)/.test(action)) return 'view'
  return 'other'
}

export function describeAuditAction(action: string): ActionMeta {
  return (
    ACTION_META[action] ?? {
      label: prettifyAction(action),
      category: categoriseFallback(action),
    }
  )
}

/** Format a resolved actor for display. `null` actorId = a system write. */
export function formatActor(actorId: string | null, actor: AuditActor | undefined): string {
  if (actorId === null) return 'System'
  if (!actor) return 'Unknown user'
  const name = actor.name?.trim()
  if (name) return name
  const email = actor.email?.trim()
  if (email) return email
  return 'Unknown user'
}

const NOISE_DIFF_KEYS = new Set(['updatedAt', 'updatedById', 'createdAt'])

/**
 * Top-level keys whose value differs between the before/after snapshots on an
 * update row. Best-effort and defensive — audit snapshots are free-form JSON.
 */
export function changedFieldsFromSnapshots(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return []
  const b = before as Record<string, unknown>
  const a = after as Record<string, unknown>
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const changed: string[] = []
  for (const key of keys) {
    if (NOISE_DIFF_KEYS.has(key)) continue
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) changed.push(key)
  }
  return changed.sort()
}

export interface RawAuditRow {
  id: string
  action: string
  actorId: string | null
  purpose: string | null
  before: unknown
  after: unknown
  occurredAt: Date | string
}

export function toAuditActivityRow(
  row: RawAuditRow,
  actorsById: Map<string, AuditActor>,
): AuditActivityRow {
  const meta = describeAuditAction(row.action)
  const changedFields =
    meta.category === 'update' ? changedFieldsFromSnapshots(row.before, row.after) : []
  return {
    id: row.id,
    action: row.action,
    label: meta.label,
    category: meta.category,
    actorLabel: formatActor(row.actorId, row.actorId ? actorsById.get(row.actorId) : undefined),
    actorId: row.actorId,
    purpose: row.purpose,
    changedFields,
    occurredAt: new Date(row.occurredAt).toISOString(),
  }
}
