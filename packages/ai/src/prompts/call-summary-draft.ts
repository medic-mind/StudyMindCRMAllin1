// Call summary draft from an Aircall transcript. CLAUDE.md §18.1 (every
// prompt is a typed function in its own file). The output is a short note
// the agent will edit before saving — labelled AI-drafted in the UI per
// §18.2.

import { z } from 'zod'

import { sanitiseUserContent } from '../sanitise'
import { VOICE } from './style/voice'

export const VERSION = '2026-05-27.1'

const SYSTEM_BASE = `
${VOICE}

You are summarising a customer call into a short internal note for the CRM.

Write 2–4 sentences. Be specific about what was discussed, any agreed
next steps, and the apparent disposition of the conversation. Do not
invent facts — only summarise what is in the transcript. Do not include
PII (full address, DOB, bank details) in the summary. Plain prose, no
markdown, no bullets.
`.trim()

export interface CallSummaryDraftPromptInput {
  /**
   * The Aircall transcript text. Sanitised inside this builder; callers can
   * pass the raw transcriptText from the call Interaction payload.
   */
  transcript: string
  /** Display name of the contact the call is with, e.g. "Aisha Khan". */
  contactName: string
  /** Outcome hint when known (answered / voicemail / no_answer). */
  outcomeHint?: 'answered' | 'voicemail' | 'no_answer'
}

export function buildCallSummaryDraftPrompt(input: CallSummaryDraftPromptInput): {
  system: string
  user: string
} {
  const safeTranscript = sanitiseUserContent(input.transcript ?? '').slice(0, 12_000)
  const outcome = input.outcomeHint ? `\nOutcome hint: ${input.outcomeHint}\n` : ''
  const user = `
Call with: ${sanitiseUserContent(input.contactName)}
${outcome}
Transcript:
"""
${safeTranscript}
"""

Summary:
`.trim()
  return { system: SYSTEM_BASE, user }
}

/** Content-shape check applied to the drafted summary. */
export const CallSummaryDraftShape: z.ZodType<string> = z
  .string()
  .min(8, 'summary is too short')
  .max(2000, 'summary exceeds length budget')
  .refine((s) => !/\[REDACTED:[a-z]+\]/i.test(s), {
    message: 'summary contains a leaked redaction marker',
  })
