// Progress-report drafting prompt. CLAUDE.md §43.3, §18.1.
//
// Produces a structured-but-free-text monthly progress report for a single
// learner-Family in a single period. Imports the statutory style fragment
// for EHCP / Section 19 / AP terminology and the safeguarding guardrail.
//
// Output is free text validated post-hoc with `progressReportShape`.
// The CRM stores it on `LAProgressReport` at state='draft' and locks
// editing once an account lead signs off.

import { z } from 'zod'

import { runDraft, type RunDraftInput } from '../../clients/draft.js'
import { sanitiseUserContent } from '../../sanitise.js'
import { HOUSE_STYLE_TENDER } from '../style/house.js'
import { SAFEGUARDING_GUARDRAIL } from '../style/safeguarding.js'
import { STATUTORY_STYLE } from '../style/statutory.js'
import { VOICE } from '../style/voice.js'

export const PROGRESS_REPORT_VERSION = '2026-05-09.1'

export interface SessionDeliverySummary {
  sessionId: string
  scheduledAt: string
  state: 'delivered' | 'no_show' | 'cancelled' | 'tentative' | 'confirmed'
  hours: number
}

export interface BuildProgressReportPromptInput {
  laName: string
  contractReference: string
  learnerInitials: string
  periodStart: string
  periodEnd: string
  sessions: ReadonlyArray<SessionDeliverySummary>
  tutorNotes: ReadonlyArray<string>
  /** Closed safeguarding flags during the period — names already redacted. */
  safeguardingClosures: ReadonlyArray<{
    flagId: string
    closedAt: string
    summary: string
  }>
  paymentStatus: 'on_track' | 'overdue' | 'paid'
}

const SYSTEM_BASE = `
${VOICE}

${HOUSE_STYLE_TENDER}

${STATUTORY_STYLE}

${SAFEGUARDING_GUARDRAIL}
`.trim()

export function buildProgressReportPrompt(
  input: BuildProgressReportPromptInput,
): { system: string; user: string; promptVersion: string } {
  const tutorNotes = input.tutorNotes
    .slice(0, 30)
    .map((n) => sanitiseUserContent(n).slice(0, 800))
  const sessions = input.sessions.slice(0, 60)
  const closures = input.safeguardingClosures.slice(0, 10)

  const deliveredHours = sessions
    .filter((s) => s.state === 'delivered')
    .reduce((acc, s) => acc + s.hours, 0)
  const totalScheduled = sessions.length
  const attendancePct =
    totalScheduled === 0
      ? 0
      : Math.round((sessions.filter((s) => s.state === 'delivered').length / totalScheduled) * 100)

  const user = [
    `LA: ${sanitiseUserContent(input.laName).slice(0, 200)}`,
    `Contract reference: ${input.contractReference}`,
    `Learner: ${input.learnerInitials}`,
    `Reporting period: ${input.periodStart} to ${input.periodEnd}`,
    `Sessions delivered: ${deliveredHours} hours across ${sessions.filter((s) => s.state === 'delivered').length} sessions.`,
    `Attendance: ${attendancePct}%`,
    `Payment status: ${input.paymentStatus}.`,
    `Tutor notes (sanitised, most recent first):\n${JSON.stringify(tutorNotes, null, 2)}`,
    `Safeguarding closures during period: ${closures.length === 0 ? 'none' : JSON.stringify(closures, null, 2)}`,
    'Draft a monthly progress report with the following section headings, in order: ## Summary, ## Attendance and engagement, ## Outcomes against EHCP, ## Safeguarding, ## Next steps. Each section is at least 80 words. Outcomes-led; cite hours and percentages.',
    'Output the report only. No preamble.',
  ].join('\n\n')

  return {
    system: SYSTEM_BASE,
    user,
    promptVersion: PROGRESS_REPORT_VERSION,
  }
}

export const progressReportShape: z.ZodType<string> = z
  .string()
  .min(600, 'progress report too short')
  .max(15_000, 'progress report exceeds length budget')
  .refine((s) => !/\[REDACTED:[a-z]+\]/i.test(s), {
    message: 'progress report contains a leaked redaction marker',
  })
  .refine((s) => /(^|\n)##\s+Summary/i.test(s), {
    message: 'progress report missing Summary heading',
  })

export interface RunProgressReportInput extends BuildProgressReportPromptInput {
  contactId?: string
  ctx?: Record<string, unknown>
}

export async function runProgressReportDraft(
  input: RunProgressReportInput,
): Promise<{ text: string; promptVersion: string }> {
  const { system, user, promptVersion } = buildProgressReportPrompt(input)
  const draftInput: RunDraftInput = {
    task: 'tender_draft', // Reuse the tender-draft budget bucket; both are
    // long-form LA-facing prose. A dedicated bucket can be added later.
    promptVersion,
    system,
    user,
    model: 'gpt-4o',
    temperature: 0.4,
    contentShape: progressReportShape,
    ctx: input.ctx,
  }
  if (input.contactId) {
    draftInput.contactId = input.contactId
  }
  const result = await runDraft(draftInput)
  return { text: result.text, promptVersion }
}
