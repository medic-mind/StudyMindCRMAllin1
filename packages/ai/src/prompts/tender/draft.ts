// Tender response drafting prompt. CLAUDE.md §43.1, §18.1.
//
// High-stakes, long-form. Imports the statutory style fragment for the
// EHCP/Section 19/AP terminology and the safeguarding guardrail to harden
// against prompt-injection in any LA-supplied brief text.
//
// Output is free text validated post-hoc with the content-shape Zod
// `tenderDraftShape` below. Drafts are stored in TenderDraftRequest with
// signoffState='pending' and labelled "DRAFT — pending review" in the UI
// until the account lead (and DSL for SEMH/EHCP-heavy work) signs off.

import { z } from 'zod'

import { runDraft, type RunDraftInput } from '../../clients/draft'
import { sanitiseUserContent } from '../../sanitise'
import { HOUSE_STYLE_TENDER } from '../style/house'
import { SAFEGUARDING_GUARDRAIL } from '../style/safeguarding'
import { STATUTORY_STYLE } from '../style/statutory'
import { VOICE } from '../style/voice'

export const TENDER_DRAFT_VERSION = '2026-05-09.1'

export interface BuildTenderDraftPromptInput {
  laName: string
  commissioner?: string | null
  /** Free-text brief supplied by the account lead. Sanitised here. */
  brief: string
  /**
   * Optional list of section headings the account lead wants drafted.
   * If omitted, the model picks sensible default headings.
   */
  sectionsToDraft: ReadonlyArray<string>
  /** True for SEMH or EHCP-heavy tenders — added emphasis on safeguarding. */
  isSemhOrEhcpHeavy: boolean
}

const SYSTEM_BASE = `
${VOICE}

${HOUSE_STYLE_TENDER}

${STATUTORY_STYLE}

${SAFEGUARDING_GUARDRAIL}
`.trim()

export function buildTenderDraftPrompt(
  input: BuildTenderDraftPromptInput,
): { system: string; user: string; promptVersion: string } {
  const brief = sanitiseUserContent(input.brief).slice(0, 6000)
  const sections =
    input.sectionsToDraft.length > 0
      ? input.sectionsToDraft.slice(0, 12)
      : [
          'Executive summary',
          'Provision model',
          'Safeguarding and DSL governance',
          'Outcomes and reporting',
          'Pricing and contract envelope',
        ]
  const safeguardingEmphasis = input.isSemhOrEhcpHeavy
    ? 'This tender is SEMH or EHCP-heavy. Lead with safeguarding governance, named DSL oversight, and how StudyMind tracks outcomes against EHCP sections B, F, and I.'
    : ''

  const userParts = [
    `LA: ${sanitiseUserContent(input.laName).slice(0, 200)}`,
    input.commissioner
      ? `Commissioner: ${sanitiseUserContent(input.commissioner).slice(0, 200)}`
      : '',
    `Brief from account lead:\n${brief}`,
    `Draft the following sections in order: ${sections.join(', ')}.`,
    safeguardingEmphasis,
    'Use clear section headings (Markdown h2 — "## Section name"). Each section should be substantive (at least 120 words) and outcomes-led.',
    'Output the draft only. No preamble, no closing notes.',
  ].filter(Boolean)

  return {
    system: SYSTEM_BASE,
    user: userParts.join('\n\n'),
    promptVersion: TENDER_DRAFT_VERSION,
  }
}

/**
 * Content-shape for tender drafts. Verbose is correct here — the floor of
 * 800 chars rejects truncated outputs while leaving plenty of headroom.
 * No leaked redaction markers. At least one Markdown section heading.
 */
export const tenderDraftShape: z.ZodType<string> = z
  .string()
  .min(800, 'tender draft too short')
  .max(20_000, 'tender draft exceeds length budget')
  .refine((s) => !/\[REDACTED:[a-z]+\]/i.test(s), {
    message: 'tender draft contains a leaked redaction marker',
  })
  .refine((s) => /(^|\n)##\s+\S/.test(s), {
    message: 'tender draft missing a Markdown section heading',
  })

export interface RunTenderDraftInput extends BuildTenderDraftPromptInput {
  contactId?: string
  ctx?: Record<string, unknown>
}

export async function runTenderDraft(input: RunTenderDraftInput): Promise<{
  text: string
  promptVersion: string
}> {
  const { system, user, promptVersion } = buildTenderDraftPrompt(input)
  const draftInput: RunDraftInput = {
    task: 'tender_draft',
    promptVersion,
    system,
    user,
    model: 'gpt-4o',
    temperature: 0.6,
    contentShape: tenderDraftShape,
    ctx: input.ctx,
  }
  if (input.contactId) {
    draftInput.contactId = input.contactId
  }
  const result = await runDraft(draftInput)
  return { text: result.text, promptVersion }
}
