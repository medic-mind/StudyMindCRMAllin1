// @studymind/ai — typed AI clients, prompts, sanitiser, budgets.
//
// Public surface only. Internal helpers (test resets, the OpenAI singleton,
// the pricing table) are reachable from inside the package but are not
// re-exported here so consumers cannot bypass the budget guardrail or the
// log/audit shape baked into the clients.

// Sanitisation — call BEFORE feeding any user content into a prompt.
export { redactPII, sanitiseUserContent, type RedactPIIOptions } from './sanitise.js'

// Restricted-contact guard. The web app injects a db client at boot so
// AI clients can refuse prompts that reference a restricted_access contact.
export {
  setRestrictedGuardDb,
  type RestrictedGuardDb,
} from './clients/restricted-guard.js'

// Budget guardrail.
export {
  BUDGETS,
  checkBudget,
  type AiTaskCategory,
  type BudgetCheckResult,
  type BudgetLimit,
  type BudgetMode,
} from './budget.js'

// Clients — the only sanctioned way to call OpenAI.
export {
  runStructured,
  type RunStructuredInput,
  type StructuredModel,
} from './clients/structured.js'
export {
  defaultDraftShape,
  runDraft,
  type DraftModel,
  type RunDraftInput,
  type RunDraftResult,
} from './clients/draft.js'
export {
  transcribeAudio,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
} from './clients/transcribe.js'

// Prompt builders. Each task ships a typed builder + a schema + a VERSION.
export {
  buildCallOutcomePrompt,
  callOutcomeSchema,
  VERSION as CALL_OUTCOME_PROMPT_VERSION,
  type CallOutcome,
  type CallOutcomePromptInput,
} from './prompts/call-outcome.js'
export {
  buildSlackSummaryPrompt,
  slackSummarySchema,
  VERSION as SLACK_SUMMARY_PROMPT_VERSION,
  type SlackSummary,
  type SlackSummaryPromptInput,
} from './prompts/slack-summary.js'
export {
  buildStatusSummaryPrompt,
  statusSummarySchema,
  VERSION as STATUS_SUMMARY_PROMPT_VERSION,
  type ContactContext,
  type StatusSummary,
  type StatusSummaryPromptInput,
} from './prompts/status-summary.js'
