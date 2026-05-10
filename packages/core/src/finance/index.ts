// Finance domain. Reconciliation, allocation, refund rules.
// See CLAUDE.md Sections 6.3, 9, and 41.2.

export const FINANCE_DOMAIN = 'finance' as const

export * from './sync-stripe'
export * from './sync-gocardless'
export * from './booking-rules'
export * from './reconcile'
// `at-risk` defines its own (compatible) `DbClient` alias; re-export the rest
// by name to avoid the type-name collision with sync-stripe.
export {
  deriveAtRisk,
  recomputeAtRiskForFamily,
  type AtRiskFamilyInput,
  type AtRiskSignals,
  type DeriveAtRiskResult,
  type RecomputeContext,
} from './at-risk'
