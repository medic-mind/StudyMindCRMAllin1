// Finance domain. Reconciliation, allocation, refund rules.
// See CLAUDE.md Sections 6.3, 9, and 41.2.

export const FINANCE_DOMAIN = 'finance' as const

export * from './sync-stripe'
export * from './sync-gocardless'
export {
  classifyProductFromText,
  type ProductCatalogueEntry,
  type ProductClassification,
} from './classify-product'
export * from './booking-rules'
export * from './reconcile'
export {
  paymentsForFamily,
  paymentSummaryForFamily,
  type PaymentProvider,
  type PaymentStatus,
  type PaymentRow,
  type PaymentSummary,
} from './customer-payments'
export {
  classifyDefaulter,
  listDefaulters,
  defaulterDetail,
  type DefaulterReason,
  type DefaulterRow,
  type DefaulterDetail,
  type ListDefaultersOptions,
} from './dd-defaulters'
export {
  deriveAtRisk,
  recomputeAtRiskForFamily,
  type AtRiskFamilyInput,
  type AtRiskSignals,
  type DeriveAtRiskResult,
  type RecomputeContext,
} from './at-risk'
