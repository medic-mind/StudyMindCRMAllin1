// Finance domain. Reconciliation, allocation, refund rules.
// See CLAUDE.md Sections 6.3, 9, and 41.2.

export const FINANCE_DOMAIN = 'finance' as const

export * from './sync-stripe'
export * from './sync-gocardless'
export {
  classifyProductFromText,
  resolveAiProductSuggestion,
  AI_PRODUCT_CONFIDENCE_THRESHOLD,
  type ProductCatalogueEntry,
  type ProductClassification,
  type AiProductSuggestionInput,
  type AcceptedAiProductSuggestion,
} from './classify-product'
export {
  recordUnresolvedStripePayment,
  listUnresolvedStripePayments,
  resolveUnresolvedStripePayment,
  dismissUnresolvedStripePayment,
  type RecordUnresolvedStripePaymentInput,
  type UnresolvedStripePaymentRow,
  type ResolveUnresolvedStripePaymentInput,
  type ResolveUnresolvedStripePaymentResult,
  type DismissUnresolvedStripePaymentInput,
  type DismissUnresolvedStripePaymentResult,
} from './unresolved-payments'
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
