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
  /** The person's individual re-signup URL (GoCardless / Stripe) — pasted by
   *  staff onto the case; substituted into every automated chase (ADR 0045). */
  setup_link?: string | null
  // --- CCJ / letter-before-claim figures (ADR 0045 amendment). Formatted
  // money strings; the caller computes them from `estimateCcjCosts`. Blank on
  // the early (gentle) steps that don't threaten court action. ---
  /** StudyMind's own late fee applied to the balance. */
  late_fee?: string | null
  /** Estimated County Court issue fee if a claim is brought. */
  court_fee?: string | null
  /** Statutory interest (8% p.a.) accrued so far. */
  interest?: string | null
  /** Interest added per day at the statutory rate. */
  daily_interest?: string | null
  /** Balance + late fee + court fee + interest — the "if it goes to court" total. */
  total_with_costs?: string | null
  /** The date by which we ask them to respond (Pre-Action Protocol). */
  response_deadline?: string | null
  /** StudyMind finance contact phone. */
  phone?: string | null
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
  'setup_link',
  'late_fee',
  'court_fee',
  'interest',
  'daily_interest',
  'total_with_costs',
  'response_deadline',
  'phone',
]

/** Pure GBP formatter (pence → "£1,234.56"). Deterministic (en-GB). */
export function formatGbpMinor(minor: number | null | undefined): string {
  if (minor == null) return ''
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)
}

/** Pure UK date formatter ("5 July 2026"). Deterministic. */
export function formatUkDate(date: Date | null | undefined): string {
  if (!date) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  }).format(date)
}

export interface BuildRecoveryVarsInput {
  fullName?: string | null
  outstandingMinor: number
  collectedMinor?: number | null
  planTotalMinor?: number | null
  planName?: string | null
  setupLinkUrl?: string | null
  phone?: string | null
  /** CCJ figures — pass to expose {{court_fee}} / {{interest}} / {{total_with_costs}}. */
  ccj?: {
    lateFeeMinor: number
    courtFeeMinor: number
    interestMinor: number
    dailyInterestMinor: number
    totalMinor: number
  } | null
  responseDeadline?: Date | null
}

/**
 * Build the token values for a recovery message from a case's live figures.
 * One implementation shared by the automated engine and the manual send so the
 * customer sees the same numbers however the message goes out.
 */
export function buildRecoveryVars(input: BuildRecoveryVarsInput): RecoveryTemplateVars {
  const full = (input.fullName ?? '').trim()
  const parts = full.split(/\s+/u).filter(Boolean)
  return {
    first_name: parts[0] ?? '',
    last_name: parts.slice(1).join(' '),
    full_name: full,
    customer_name: full,
    plan_name: input.planName ?? '',
    amount_due: formatGbpMinor(input.outstandingMinor),
    collected: input.collectedMinor != null ? formatGbpMinor(input.collectedMinor) : '',
    plan_total: input.planTotalMinor != null ? formatGbpMinor(input.planTotalMinor) : '',
    setup_link: input.setupLinkUrl ?? '',
    late_fee: input.ccj ? formatGbpMinor(input.ccj.lateFeeMinor) : '',
    court_fee: input.ccj ? formatGbpMinor(input.ccj.courtFeeMinor) : '',
    interest: input.ccj ? formatGbpMinor(input.ccj.interestMinor) : '',
    daily_interest: input.ccj ? formatGbpMinor(input.ccj.dailyInterestMinor) : '',
    total_with_costs: input.ccj ? formatGbpMinor(input.ccj.totalMinor) : '',
    response_deadline: formatUkDate(input.responseDeadline),
    phone: input.phone ?? '',
  }
}

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
