// @studymind/ai — typed AI clients, prompts, sanitiser, budgets.
//
// Public surface only. Internal helpers (test resets, the OpenAI singleton,
// the pricing table) are reachable from inside the package but are not
// re-exported here so consumers cannot bypass the budget guardrail or the
// log/audit shape baked into the clients.

// Sanitisation — call BEFORE feeding any user content into a prompt.
export { redactPII, sanitiseUserContent, type RedactPIIOptions } from './sanitise'

// Restricted-contact guard. The web app injects a db client at boot so
// AI clients can refuse prompts that reference a restricted_access contact.
export { setRestrictedGuardDb, type RestrictedGuardDb } from './clients/restricted-guard'

// Drift sampling — 1% of production AI calls land in DriftSample for
// weekly reviewer triage. Web app injects the db at boot.
export {
  sampleForDrift,
  setDriftSampleDb,
  setDriftSampleRate,
  type DriftSampleDb,
  type SampleForDriftInput,
} from './drift'

// Budget guardrail.
export {
  BUDGETS,
  checkBudget,
  type AiTaskCategory,
  type BudgetCheckResult,
  type BudgetLimit,
  type BudgetMode,
} from './budget'

// Provider resolution (ADR 0028). The site runs on Gemini by default and can
// fall back to OpenAI; these expose the active provider for display/diagnostics.
export {
  resolveProvider,
  resolveModel,
  resolveTranscriptionModel,
  type AiProvider,
  type ModelTier,
} from './clients/models'

// Clients — the only sanctioned way to call the AI provider (Gemini / OpenAI).
export { runStructured, type RunStructuredInput, type StructuredModel } from './clients/structured'
export {
  defaultDraftShape,
  runDraft,
  type DraftModel,
  type RunDraftInput,
  type RunDraftResult,
} from './clients/draft'
export {
  transcribeAudio,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
} from './clients/transcribe'

// Prompt builders. Each task ships a typed builder + a schema + a VERSION.
export {
  buildCallOutcomePrompt,
  callOutcomeSchema,
  VERSION as CALL_OUTCOME_PROMPT_VERSION,
  type CallOutcome,
  type CallOutcomePromptInput,
} from './prompts/call-outcome'
export {
  buildSlackSummaryPrompt,
  slackSummarySchema,
  VERSION as SLACK_SUMMARY_PROMPT_VERSION,
  type SlackSummary,
  type SlackSummaryPromptInput,
} from './prompts/slack-summary'
export {
  buildMergeCandidatesPrompt,
  mergeCandidateSchema,
  MERGE_SUGGESTION_THRESHOLD,
  VERSION as MERGE_CANDIDATES_PROMPT_VERSION,
  type ContactSummaryForMerge,
  type MergeCandidate,
  type MergeCandidatesPromptInput,
} from './prompts/merge-candidates'
export {
  buildChurnScorePrompt,
  CHURN_TASK_THRESHOLD,
  churnScoreSchema,
  VERSION as CHURN_SCORE_PROMPT_VERSION,
  type ChurnScoreOutput,
  type ChurnScorePromptInput,
  type ChurnSignals,
} from './prompts/churn-score'
export {
  buildReplyDraftPrompt,
  replyDraftShape,
  VERSION as REPLY_DRAFT_PROMPT_VERSION,
  type InteractionListItem,
  type ReplyChannel,
  type ReplyDraftPromptInput,
} from './prompts/reply-draft'
export {
  buildCallSummaryDraftPrompt,
  CallSummaryDraftShape,
  VERSION as CALL_SUMMARY_DRAFT_PROMPT_VERSION,
  type CallSummaryDraftPromptInput,
} from './prompts/call-summary-draft'
export {
  buildStatusSummaryPrompt,
  statusSummarySchema,
  VERSION as STATUS_SUMMARY_PROMPT_VERSION,
  type ContactContext,
  type StatusSummary,
  type StatusSummaryPromptInput,
} from './prompts/status-summary'
export {
  buildLeadClassificationPrompt,
  leadClassificationSchema,
  VERSION as LEAD_CLASSIFICATION_PROMPT_VERSION,
  type LeadClassificationAi,
  type LeadClassificationPromptInput,
} from './prompts/lead-classification'
export {
  buildProductClassificationPrompt,
  productClassificationSchema,
  VERSION as PRODUCT_CLASSIFICATION_PROMPT_VERSION,
  type ProductClassificationAi,
  type ProductClassificationPromptInput,
  type ProductCatalogueOption,
} from './prompts/product-classification'
