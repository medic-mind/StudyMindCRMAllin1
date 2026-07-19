// Finance domain. Reconciliation, allocation, refund rules.
// See CLAUDE.md Sections 6.3, 9, and 41.2.

export const FINANCE_DOMAIN = 'finance' as const

export * from './sync-stripe'
export * from './sync-gocardless'
// Complete GoCardless provider mirror (ADR 0038). MandateStateValue is
// deliberately not re-exported here — sync-gocardless already owns that name.
export {
  findContactForGcCustomer,
  findContactForGcEmail,
  findContactForGcPhone,
  linkGcCustomer,
  linkUnlinkedGcCustomers,
  pickUnambiguousContact,
  upsertGcCustomerMirror,
  upsertGcMandateMirror,
  upsertGcPaymentMirror,
  upsertGcPayoutMirror,
  upsertGcSubscriptionMirror,
  type BackfillLinkResult,
  type ContactMatchCandidate,
  type GcPaymentStateValue,
  type GcSubscriptionStateValue,
  type LinkGcCustomerResult,
  type UpsertGcCustomerInput,
  type UpsertGcCustomerResult,
  type UpsertGcMandateMirrorInput,
  type UpsertGcPaymentMirrorInput,
  type UpsertGcPayoutInput,
  type UpsertGcSubscriptionInput,
} from './gc-mirror'
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
// Durable Direct Debit sign-up links + email automation (ADR 0038 amendment).
export {
  completeSetupLink,
  createMandateSetupLink,
  expireStaleSetupLinks,
  generateSetupLinkToken,
  listSetupLinkReminderCandidates,
  markSetupLinkEmailed,
  recordSetupLinkOpen,
  resolveSetupLinkForOpen,
  revokeSetupLink,
  SETUP_LINK_REMINDER_AFTER_DAYS,
  SETUP_LINK_TTL_DAYS,
  setupLinkOpenState,
  type CreateSetupLinkInput,
  type OpenableSetupLink,
  type ReminderCandidate,
  type ResolveSetupLinkResult,
  type RevokeSetupLinkResult,
  type SetupLinkRecord,
  type SetupLinkStatus,
} from './dd-setup-links'
// Direct Debit dashboard insights (ADR 0038) — pure money maths.
export {
  monthlyEquivalentMinor,
  monthlyRunRateMinor,
  type PlanCadence,
} from './dd-insights'
// Direct Debit recovery cases (ADR 0038) — the agent workflow to recover a
// cancelled/underpaid plan's shortfall.
export {
  assignCase,
  canTransition,
  CaseTransitionError,
  DD_CASE_STATUSES,
  getCasesForSubscriptions,
  getOrCreateCase,
  isClosedStatus,
  recordRecovery,
  RECOVERY_METHODS,
  setCaseNotes,
  setCaseStatus,
  type DirectDebitCaseRow,
  type DirectDebitCaseStatusValue,
  type RecoveryMethodValue,
  type UpsertCaseInput,
} from './dd-cases'
// Direct Debit recovery-comms templates (ADR 0038, Phase 3) — pure rendering.
export {
  renderRecoveryTemplate,
  RECOVERY_TEMPLATE_TOKENS,
  type RecoveryTemplateVars,
} from './dd-comms'
// Automated Direct Debit chasing (ADR 0045) — pure engine decisions.
export {
  chaseAutoResolved,
  decideChaseTick,
  nextChaseAt,
  type ChaseCaseState,
  type ChaseChannel,
  type ChaseTemplateRef,
  type ChaseTickDecision,
} from './dd-chase'
// Direct Debit plan shortfalls (ADR 0038) — cancelled-part-way / underpaid plans
// and active plans behind their collection schedule.
export {
  ARREARS_THRESHOLD,
  classifyActivePlanArrears,
  classifyPlanShortfall,
  expectedInstalmentsByNow,
  listActivePlanArrears,
  listPlanShortfalls,
  type ActivePlanArrears,
  type ActivePlanArrearsWithCustomer,
  type ActivePlanFacts,
  type ListActivePlanArrearsOptions,
  type PlanFacts,
  type PlanScheduleInput,
  type PlanShortfall,
  type PlanShortfallReason,
  type PlanShortfallWithCustomer,
} from './dd-plan-shortfall'
