// Customer-facing call-summary draft. CLAUDE.md §18.1 (every prompt is a typed
// function in its own file). The output is the SHORT message we send the
// customer right after the call, from the agent who spoke to them — a warm
// greeting plus 4–5 bullets. The agent edits it before sending and it is
// labelled AI-drafted in the UI (§18.2).

import { z } from 'zod'

import { sanitiseUserContent } from '../sanitise'
import { VOICE } from './style/voice'

export const VERSION = '2026-06-10.1'

const SYSTEM_BASE = `
${VOICE}

You are drafting the short message StudyMind sends a customer immediately
after a phone call, written by the agent who just spoke to them. It is
customer-facing, warm and specific.

Format the message EXACTLY like this:
  Line 1: "Hi <customer first name>, thank you for speaking to me just now (<agent first name>)"
  Then a blank line.
  Then 4–5 bullet points, each starting with "* ", one fact each.

Each bullet captures one thing the customer told us or asked for. Adapt to
what was ACTUALLY discussed — it may be 1-1 subject tutoring, a summer camp
place, group classes, an admissions test, exam dates, pricing, a trial
lesson, and so on. Do NOT assume it is subject tutoring; be led by the call.
Typical bullets look like:
  * You are looking for 1-1 tutoring for <subject>
  * Your exam / course is <…>
  * You would like <what they asked us to do>

Rules:
- Keep it to 4–5 bullets. One fact per bullet, warm but concise, no fluff.
- Only use facts from the transcript / context provided. Never invent
  specifics (dates, prices, names).
- If a key detail was not captured, write a short fill-in placeholder the
  agent can complete, e.g. "* Your exam is ___".
- No PII beyond the first name (no full address, DOB, or bank details).
- Plain text. The ONLY markdown is the "* " at the start of each bullet.
`.trim()

export interface CallSummaryDraftPromptInput {
  /**
   * The Aircall transcript text. Sanitised inside this builder; callers can
   * pass the raw transcriptText from the call Interaction payload. May be
   * empty — when there is no transcript the model produces a scaffold the
   * agent fills in.
   */
  transcript: string
  /** Display name of the contact the call is with, e.g. "Aisha Khan". */
  contactName: string
  /** Name of the agent who made the call (the "(caller name)" in the greeting). */
  callerName?: string | null
  /** What we already know the customer is interested in (subjects / products). */
  interests?: ReadonlyArray<string>
  /** Outcome hint when known (answered / voicemail / no_answer). */
  outcomeHint?: 'answered' | 'voicemail' | 'no_answer'
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim()
}

export function buildCallSummaryDraftPrompt(input: CallSummaryDraftPromptInput): {
  system: string
  user: string
} {
  const safeTranscript = sanitiseUserContent(input.transcript ?? '').slice(0, 12_000)
  const outcome = input.outcomeHint ? `Outcome hint: ${input.outcomeHint}\n` : ''
  const caller = input.callerName ? sanitiseUserContent(firstNameOf(input.callerName)) : 'the agent'
  const interests =
    input.interests && input.interests.length > 0
      ? `Known interests / subjects: ${sanitiseUserContent(input.interests.join(', '))}\n`
      : ''
  const transcriptBlock = safeTranscript
    ? `Transcript:\n"""\n${safeTranscript}\n"""`
    : 'Transcript: (none captured — produce the greeting and 4–5 fill-in bullets the agent can complete)'
  const user = `
Customer first name: ${sanitiseUserContent(firstNameOf(input.contactName))}
Agent (caller) first name: ${caller}
${interests}${outcome}
${transcriptBlock}

Message:
`.trim()
  return { system: SYSTEM_BASE, user }
}

/**
 * Deterministic fallback used when the AI is unavailable (no key, rate limit,
 * content-shape failure) so the "AI draft" button NEVER leaves the agent with
 * nothing — it hands back the same greeting + fill-in bullets to complete.
 * Diverse on purpose (no hard-coded "tutoring").
 */
export function buildCallSummaryScaffold(
  contactName: string,
  callerName: string | null,
  interests?: ReadonlyArray<string>,
): string {
  const first = firstNameOf(contactName || 'there')
  const caller = callerName ? firstNameOf(callerName) : 'the team'
  const subject = interests && interests.length > 0 ? interests.join(', ') : '___'
  return [
    `Hi ${first}, thank you for speaking to me just now (${caller})`,
    '',
    `* What you're looking for: ___`,
    `* Subject / programme: ${subject}`,
    `* Your exam / key dates: ___`,
    `* What you'd like us to do next: ___`,
  ].join('\n')
}

/** Content-shape check applied to the drafted summary. */
export const CallSummaryDraftShape: z.ZodType<string> = z
  .string()
  .min(8, 'summary is too short')
  .max(2000, 'summary exceeds length budget')
  .refine((s) => !/\[REDACTED:[a-z]+\]/i.test(s), {
    message: 'summary contains a leaked redaction marker',
  })
