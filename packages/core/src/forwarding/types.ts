// Forwarding rule schemas. A rule is the configurable record behind a
// "Forward to <team>" quick action on a contact: recipients, subject template,
// body template. Manager+ manages the catalogue; Sales Executive+ triggers
// sends. CLAUDE.md §20.1.

import { z } from 'zod'

const EmailList = z
  .array(z.string().trim().email())
  .max(20)
  .default([])

/**
 * `key` is the stable identifier (e.g. `ap_team`, `ceos`). Lower-snake.
 * Used in the UI dropdown and the Interaction payload so a Contact's
 * timeline shows which rule fired even if the label is later renamed.
 */
const RuleKey = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/u, 'Use lower_snake_case (a-z, 0-9, _)')

export const ForwardingRuleCreateInput = z.object({
  key: RuleKey,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(280).optional().nullable(),
  toAddresses: z.array(z.string().trim().email()).min(1).max(20),
  ccAddresses: EmailList,
  bccAddresses: EmailList,
  subjectTemplate: z.string().trim().min(1).max(200),
  bodyTemplate: z.string().trim().min(1).max(8000),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})
export type ForwardingRuleCreateInput = z.infer<typeof ForwardingRuleCreateInput>

export const ForwardingRuleUpdateInput = z.object({
  id: z.string(),
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(280).nullish(),
  toAddresses: z.array(z.string().trim().email()).min(1).max(20).optional(),
  ccAddresses: EmailList.optional(),
  bccAddresses: EmailList.optional(),
  subjectTemplate: z.string().trim().min(1).max(200).optional(),
  bodyTemplate: z.string().trim().min(1).max(8000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})
export type ForwardingRuleUpdateInput = z.infer<typeof ForwardingRuleUpdateInput>

export const ForwardingRuleSummary = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  toAddresses: z.array(z.string()),
  ccAddresses: z.array(z.string()),
  bccAddresses: z.array(z.string()),
  subjectTemplate: z.string(),
  bodyTemplate: z.string(),
  sortOrder: z.number().int(),
  archived: z.boolean(),
})
export type ForwardingRuleSummary = z.infer<typeof ForwardingRuleSummary>

/**
 * Variables the templates may reference. Keep the surface small and stable —
 * `templates.ts` does plain `{{name}}` substitution and missing values render
 * as an empty string so a rule never blocks on an unset field.
 */
export const ForwardingTemplateContext = z.object({
  contactName: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string(),
  contactId: z.string(),
  contactLink: z.string(),
  familyName: z.string(),
  agentName: z.string(),
  agentEmail: z.string(),
  notes: z.string(),
})
export type ForwardingTemplateContext = z.infer<typeof ForwardingTemplateContext>

/**
 * The shape the agent submits when sending a forward. Subject and body are
 * editable in the UI before send — the server uses what the agent supplies
 * rather than re-rendering, so the audit trail reflects what was actually
 * sent. Recipient lists are server-side from the rule (the agent never types
 * email addresses freehand; that's a separate "compose email" surface).
 */
export const ForwardingSendInput = z.object({
  contactId: z.string(),
  ruleId: z.string(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10_000),
})
export type ForwardingSendInput = z.infer<typeof ForwardingSendInput>

export const ForwardingSendResult = z.object({
  status: z.enum(['sent', 'skipped', 'failed']),
  interactionId: z.string(),
  resendId: z.string().nullable(),
  detail: z.string().optional(),
})
export type ForwardingSendResult = z.infer<typeof ForwardingSendResult>
