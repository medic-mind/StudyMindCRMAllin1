// Call outcome classifier prompt. See CLAUDE.md Sections 10 and 18.
//
// Used by the Aircall fallback flow (no AI Assist) to label a Whisper
// transcript with the call outcome and a brief follow-up suggestion.
// Cheap mini-task; structured output via runStructured.

import { z } from 'zod'

import { sanitiseUserContent } from '../sanitise.js'
import { SAFEGUARDING_GUARDRAIL } from './style/safeguarding.js'

export const VERSION = '2026-05-04.1'

export const callOutcomeSchema = z.object({
  outcome: z.enum(['voicemail', 'human', 'no_answer']),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  suggestedFollowUp: z.string().min(1).max(280).nullable(),
  confidence: z.number().min(0).max(1),
})

export type CallOutcome = z.infer<typeof callOutcomeSchema>

export interface CallOutcomePromptInput {
  transcript: string
}

const SYSTEM = `
You classify the outcome of a recorded phone call from a transcript. You
return JSON matching the provided schema and nothing else. The voice style
fragment is not relevant for this task; do not draft prose, only classify.

${SAFEGUARDING_GUARDRAIL}

Definitions:
- outcome="voicemail": the call reached a voicemail greeting and the caller
  either left a message or hung up. No live conversation happened.
- outcome="human": a person other than the answering machine spoke and a
  conversation took place, however brief.
- outcome="no_answer": the line rang out, was busy, or was disconnected
  before any voicemail or human pickup.

sentiment is the dominant tone of the human side of the conversation when
present, otherwise "neutral".

suggestedFollowUp is a short imperative for the assigned ops agent
("Schedule trial session", "Resend payment link", "Escalate to DSL"). If no
follow-up is warranted, return null.

confidence is your self-assessed probability that the outcome label is
correct, in [0, 1].
`.trim()

export function buildCallOutcomePrompt(
  input: CallOutcomePromptInput,
): { system: string; user: string; promptVersion: string } {
  const safeTranscript = sanitiseUserContent(input.transcript)
  const user = `Transcript:\n"""\n${safeTranscript}\n"""`
  return { system: SYSTEM, user, promptVersion: VERSION }
}
