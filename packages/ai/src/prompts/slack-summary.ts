// Slack summary parser prompt. CLAUDE.md §12, §18.
//
// Extracts a candidate-Contact identifier, a short summary, sentiment, and a
// suggested next action from a Slack message in a watched channel. Used by
// the slack/event.received Inngest function. Cheap mini-task; runStructured.

import { z } from 'zod'

import { sanitiseUserContent } from '../sanitise.js'
import { SAFEGUARDING_GUARDRAIL } from './style/safeguarding.js'

export const VERSION = '2026-05-09.1'

export const slackSummarySchema = z.object({
  candidateContactIdentifier: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  summary: z.string().min(1).max(600),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  suggestedNextAction: z.string().min(1).max(280).nullable(),
  confidence: z.number().min(0).max(1),
})

export type SlackSummary = z.infer<typeof slackSummarySchema>

export interface SlackSummaryPromptInput {
  channelName?: string | null
  authorDisplayName?: string | null
  text: string
}

const SYSTEM = `
You read a single Slack message from a StudyMind staff channel and extract a
short structured summary that links the message to a CRM Contact, if it
references one. Return JSON matching the provided schema and nothing else.

${SAFEGUARDING_GUARDRAIL}

Definitions:
- candidateContactIdentifier: any name, email, or UK phone number that the
  message refers to (a parent, student, tutor, or LA caseworker). Each field
  is independent: include what is present, set the others to null. If the
  message references no person, set all three to null.
- summary: one or two sentences. No PII beyond what already appears in the
  message. Past tense.
- sentiment: dominant tone of the matter being discussed.
- suggestedNextAction: a short imperative for the assigned ops agent. Null
  if no follow-up is warranted.
- confidence: your self-assessed probability that the candidate identifier
  uniquely points to one CRM Contact, in [0, 1]. If the message does not
  reference a person at all, set confidence to 0.

Never invent identifiers. Names without context are low confidence.
`.trim()

export function buildSlackSummaryPrompt(
  input: SlackSummaryPromptInput,
): { system: string; user: string; promptVersion: string } {
  const safeText = sanitiseUserContent(input.text)
  const channel = input.channelName ?? '(unknown)'
  const author = input.authorDisplayName ?? '(unknown)'
  const user = `Channel: ${channel}\nAuthor: ${author}\nMessage:\n"""\n${safeText}\n"""`
  return { system: SYSTEM, user, promptVersion: VERSION }
}
