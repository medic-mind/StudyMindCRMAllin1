// Friendly UI labels for the canonical sales-CRM roles (ADR 0014).
//
// The canonical Postgres enum values are snake_case (`sales_executive`); the
// UI shows the title-case label. Legacy enum values (`super_admin`, `admin`,
// `agent`, ...) are normalised via the LEGACY_ROLE_MAP in
// `@studymind/core/auth/policies` so this helper accepts either form.

import { normaliseRole, type Role } from '@studymind/core/auth/policies'

const LABELS: Readonly<Record<Role, string>> = {
  ceo: 'CEO',
  senior_manager: 'Senior Manager',
  manager: 'Manager',
  sales_executive: 'Sales Executive',
  virtual_assistant: 'Virtual Assistant',
}

/**
 * Format a role for display in the UI. Accepts canonical Role values and
 * legacy strings. Unknown inputs are returned verbatim so the chrome never
 * blanks out, but you should treat that as a bug (file a follow-up).
 */
export function formatRoleLabel(role: string): string {
  const canonical = normaliseRole(role)
  if (canonical) return LABELS[canonical]
  return role
}
