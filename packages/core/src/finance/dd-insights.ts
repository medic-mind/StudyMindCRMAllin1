// Direct Debit dashboard insights (ADR 0038). Pure money maths for the
// master dashboard — no I/O, integer minor units only (CLAUDE.md §19).

export interface PlanCadence {
  amountMinor: number
  /** weekly | monthly | yearly — normalised text from the mirror. */
  intervalUnit: string
  /** Every N units (GoCardless `interval`, default 1). */
  interval: number
}

/**
 * Normalise one plan to its monthly equivalent in minor units.
 * weekly ×52/12 · monthly ×1 · yearly ÷12, all divided by `interval`.
 * Unknown units contribute 0 — fail closed (§8) rather than guess.
 */
export function monthlyEquivalentMinor(plan: PlanCadence): number {
  const interval = plan.interval > 0 ? plan.interval : 1
  switch (plan.intervalUnit) {
    case 'weekly':
      return Math.round((plan.amountMinor * 52) / 12 / interval)
    case 'monthly':
      return Math.round(plan.amountMinor / interval)
    case 'yearly':
      return Math.round(plan.amountMinor / (12 * interval))
    default:
      return 0
  }
}

/** Sum the monthly run rate of a set of (active) plans. */
export function monthlyRunRateMinor(plans: PlanCadence[]): number {
  return plans.reduce((sum, plan) => sum + monthlyEquivalentMinor(plan), 0)
}
