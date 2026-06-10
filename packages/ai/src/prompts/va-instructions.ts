// Internal "next steps for the team / VA" draft after a customer call. CLAUDE.md
// §18.1. This is NOT customer-facing — it is the action-point list an agent
// hands to the VA team (step 2 of the call-summary flow). The agent edits it
// before saving; it is labelled AI-drafted in the UI (§18.2).

import { z } from 'zod'

import { sanitiseUserContent } from '../sanitise'
import { VOICE } from './style/voice'

export const VERSION = '2026-06-10.1'

const SYSTEM_BASE = `
${VOICE}

You are writing the INTERNAL next-step instructions for the StudyMind team /
virtual assistants after a customer phone call. This is NOT sent to the
customer — it is a short, concrete action list for the team.

Output 3–5 bullet points, each starting with "* ", one action each. Be
specific and actionable. Common next steps (adapt to what was actually
discussed — it may be 1-1 tutoring, a summer camp, an admissions course, etc.;
do NOT assume subject tutoring):
  * Send a 30-minute (or 1-hour) trial lesson for <subject>
  * Send all the relevant details / pricing / tutor profiles for <subject or programme>
  * Book or confirm the trial / next session
  * Follow up on anything specific the customer asked for

Rules:
- Keep it to 3–5 bullets, one action each, concise and concrete.
- Only use facts from the context. If a detail is unknown, write a short
  fill-in placeholder the agent can complete (e.g. "* Send pricing for ___").
- No customer PII beyond a first name.
- Plain text. The ONLY markdown is the "* " at the start of each bullet.
`.trim()

export interface VaInstructionsPromptInput {
  /** The customer the call was with, e.g. "Aisha Khan". */
  contactName: string
  /** What we already know the customer is interested in (subjects / products). */
  interests?: ReadonlyArray<string>
  /** The customer-facing summary the agent just drafted, when available. */
  customerSummary?: string
  /** The call transcript, when available (sanitised inside this builder). */
  transcript?: string
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim()
}

export function buildVaInstructionsPrompt(input: VaInstructionsPromptInput): {
  system: string
  user: string
} {
  const interests =
    input.interests && input.interests.length > 0
      ? `Known interests / subjects: ${sanitiseUserContent(input.interests.join(', '))}\n`
      : ''
  const summary = input.customerSummary
    ? `What we told the customer:\n"""\n${sanitiseUserContent(input.customerSummary).slice(0, 4_000)}\n"""\n`
    : ''
  const transcript = input.transcript
    ? `Call transcript:\n"""\n${sanitiseUserContent(input.transcript).slice(0, 8_000)}\n"""`
    : 'Call transcript: (none captured — produce sensible default next steps the agent can adjust)'
  const user = `
Customer: ${sanitiseUserContent(firstNameOf(input.contactName))}
${interests}${summary}
${transcript}

Next steps for the team:
`.trim()
  return { system: SYSTEM_BASE, user }
}

/**
 * Deterministic fallback when the AI is unavailable so the "AI suggest" button
 * never no-ops. Diverse on purpose (no hard-coded "tutoring").
 */
export function buildVaInstructionsScaffold(interests?: ReadonlyArray<string>): string {
  const subject = interests && interests.length > 0 ? interests.join(', ') : 'the relevant subject'
  return [
    `* Send a 30-minute trial lesson for ${subject}`,
    `* Send all the relevant details + pricing for ${subject}`,
    `* Book / confirm the trial or next session`,
    `* Follow up on anything the customer specifically asked for: ___`,
  ].join('\n')
}

/** Content-shape check applied to the drafted instructions. */
export const VaInstructionsShape: z.ZodType<string> = z
  .string()
  .min(8, 'instructions are too short')
  .max(2000, 'instructions exceed length budget')
  .refine((s) => !/\[REDACTED:[a-z]+\]/i.test(s), {
    message: 'instructions contain a leaked redaction marker',
  })
