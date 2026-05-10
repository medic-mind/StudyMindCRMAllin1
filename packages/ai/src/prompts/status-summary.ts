// Status summary prompt. CLAUDE.md §18, §17.1 (every 30 min for changed contacts).
//
// Produces a 2-line "Current Status" header for a Contact: a one-line
// header and a one-line body. Cheap mini-task; gpt-4o-mini via runStructured.
// Input is intentionally slim and pre-redacted — never feed safeguarding
// bodies (CLAUDE.md §18.1, §42.3). The caller (the Inngest job) is
// responsible for excluding contacts with restricted_access.

import { z } from 'zod'

import { sanitiseUserContent } from '../sanitise'
import { SAFEGUARDING_GUARDRAIL } from './style/safeguarding'

export const VERSION = '2026-05-09.1'

export const statusSummarySchema = z.object({
  headerLine: z.string().min(1).max(220),
  bodyLine: z.string().min(1).max(320),
})

export type StatusSummary = z.infer<typeof statusSummarySchema>

/** Slim per-Contact context. Never include safeguarding bodies. */
export interface ContactContext {
  /** First name only — minor surnames are not fed to the model. */
  firstName: string | null
  /** parent / student / tutor / la_caseworker / other. */
  kind: string
  /** Recent interactions — already redacted to type + ISO occurredAt + brief. */
  recentInteractions: Array<{
    type: string
    occurredAt: string
    brief: string
  }>
  /** Open Task summaries. */
  openTasks: Array<{ title: string; dueAt: string | null }>
  /** Unresolved reconciliation discrepancies (category + summary). */
  openDiscrepancies: Array<{ category: string; summary: string }>
  /**
   * Whether the contact (or their family) currently has any safeguarding
   * flag at all. Body content NEVER comes through. CLAUDE.md §18.1.
   */
  hasSafeguardingFlag: boolean
}

const SYSTEM = `
You write a two-line "Current Status" header for a CRM Contact in the
StudyMind All in One CRM. Return JSON matching the schema and nothing else.

${SAFEGUARDING_GUARDRAIL}

Definitions:
- headerLine: a single line up to 220 characters. Past or present tense.
  Names the most recent material event ("Trial booked for 12 May",
  "Two failed Direct Debits, finance reviewing"). No emoji. No exclamation.
- bodyLine: one line up to 320 characters with the next-best-action context
  ("Awaiting parent reply since 06 May" / "DSL acknowledged; review due").
  Concrete, no marketing tone, British English.

Rules:
- Do not include the contact's surname.
- If hasSafeguardingFlag is true, mention only that "a safeguarding matter
  is open" — never any detail.
- If you do not have enough signal, say so plainly ("No recent activity;
  last interaction was an inbound enquiry on …").
`.trim()

export interface StatusSummaryPromptInput {
  context: ContactContext
}

export function buildStatusSummaryPrompt(
  input: StatusSummaryPromptInput,
): { system: string; user: string; promptVersion: string } {
  // Stringify the slim context. We sanitise each free-text field
  // individually so the model never sees raw inbound content.
  const ctx = input.context
  const interactions = ctx.recentInteractions.map((i) => ({
    type: i.type,
    at: i.occurredAt,
    brief: sanitiseUserContent(i.brief).slice(0, 200),
  }))
  const tasks = ctx.openTasks.map((t) => ({
    title: sanitiseUserContent(t.title).slice(0, 160),
    dueAt: t.dueAt,
  }))
  const discrepancies = ctx.openDiscrepancies.map((d) => ({
    category: d.category,
    summary: sanitiseUserContent(d.summary).slice(0, 200),
  }))

  const payload = {
    contact: { firstName: ctx.firstName, kind: ctx.kind },
    hasSafeguardingFlag: ctx.hasSafeguardingFlag,
    interactions,
    tasks,
    discrepancies,
  }
  const user = `Context:\n${JSON.stringify(payload, null, 2)}`
  return { system: SYSTEM, user, promptVersion: VERSION }
}
