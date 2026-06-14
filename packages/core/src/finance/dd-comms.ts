// Direct Debit recovery-comms templates (ADR 0038, Phase 3). Staff author the
// reminder / legal-escalation copy (we ship none); this module just renders a
// template body/subject by substituting {{tokens}}. Pure — no I/O, no sending.
// The human-confirmed send (Phase 3b) reuses `renderRecoveryTemplate`.

/** The tokens a recovery template may use. Unknown tokens are left untouched
 *  so a typo is visible rather than silently blanked. */
export interface RecoveryTemplateVars {
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  customer_name?: string | null
  plan_name?: string | null
  /** Formatted money strings (the caller formats pence → "£800.00"). */
  amount_due?: string | null
  collected?: string | null
  plan_total?: string | null
}

export const RECOVERY_TEMPLATE_TOKENS: Array<keyof RecoveryTemplateVars> = [
  'first_name',
  'last_name',
  'full_name',
  'customer_name',
  'plan_name',
  'amount_due',
  'collected',
  'plan_total',
]

/**
 * Replace `{{token}}` occurrences (with optional inner whitespace) using the
 * provided vars. A token with no value resolves to an empty string; an
 * unregistered token is left as-is. Pure + deterministic.
 */
export function renderRecoveryTemplate(
  template: string,
  vars: RecoveryTemplateVars,
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gu, (match, token: string) => {
    if (!(RECOVERY_TEMPLATE_TOKENS as string[]).includes(token)) return match
    const value = vars[token as keyof RecoveryTemplateVars]
    return value == null ? '' : String(value)
  })
}
