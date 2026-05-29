// @studymind/core/forwarding — configurable "Forward to <team>" quick action
// on a contact. The rule catalogue lives in `ForwardingRule`; the orchestrator
// in `forward.ts` sends via an injected sender (Resend in production) and
// records an `email_forwarded` Interaction on the contact.

export {
  ForwardingRuleCreateInput,
  ForwardingRuleUpdateInput,
  ForwardingRuleSummary,
  ForwardingSendInput,
  ForwardingSendResult,
  ForwardingTemplateContext,
  type ForwardingRuleCreateInput as ForwardingRuleCreateInputT,
  type ForwardingRuleUpdateInput as ForwardingRuleUpdateInputT,
  type ForwardingRuleSummary as ForwardingRuleSummaryT,
  type ForwardingSendInput as ForwardingSendInputT,
  type ForwardingSendResult as ForwardingSendResultT,
  type ForwardingTemplateContext as ForwardingTemplateContextT,
} from './types'

export { renderTemplate, TEMPLATE_VARIABLES } from './templates'

export {
  buildTemplateContext,
  renderRule,
  forwardEmail,
  type ActorCtx,
  type ForwardingSender,
  type ForwardingSenderArgs,
  type ForwardingSenderResult,
} from './forward'

export { listRules, getRule, getRuleByKey } from './rules'

export { DEFAULT_FORWARDING_RULES, type DefaultForwardingRule } from './defaults'
