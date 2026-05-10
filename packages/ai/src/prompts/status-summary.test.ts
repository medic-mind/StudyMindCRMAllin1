// Tests for the status-summary prompt builder. CLAUDE.md §17.1, §18.

import { describe, expect, it } from 'vitest'

import {
  buildStatusSummaryPrompt,
  statusSummarySchema,
  VERSION,
  type ContactContext,
} from './status-summary'

const baseContext: ContactContext = {
  firstName: 'Sam',
  kind: 'parent',
  recentInteractions: [
    { type: 'call', occurredAt: '2026-05-08T10:00:00Z', brief: 'Spoke about trial' },
  ],
  openTasks: [{ title: 'Confirm trial slot', dueAt: '2026-05-12T09:00:00Z' }],
  openDiscrepancies: [],
  hasSafeguardingFlag: false,
}

describe('buildStatusSummaryPrompt', () => {
  it('stamps the version and is deterministic', () => {
    const a = buildStatusSummaryPrompt({ context: baseContext })
    const b = buildStatusSummaryPrompt({ context: baseContext })
    expect(a).toEqual(b)
    expect(a.promptVersion).toBe(VERSION)
  })

  it('does not include surnames anywhere in the input', () => {
    const out = buildStatusSummaryPrompt({ context: baseContext })
    // Only firstName is fed in; the schema/context has no surname field.
    expect(out.user).not.toMatch(/lastName/)
  })

  it('reflects safeguarding flag presence as a boolean only', () => {
    const out = buildStatusSummaryPrompt({
      context: { ...baseContext, hasSafeguardingFlag: true },
    })
    expect(out.user).toMatch(/"hasSafeguardingFlag": true/)
  })
})

describe('statusSummarySchema', () => {
  it('accepts a valid two-line summary', () => {
    const parsed = statusSummarySchema.parse({
      headerLine: 'Trial confirmed for 12 May.',
      bodyLine: 'Awaiting parent reply on session length.',
    })
    expect(parsed.headerLine).toMatch(/Trial/)
  })

  it('rejects an empty header', () => {
    expect(() =>
      statusSummarySchema.parse({ headerLine: '', bodyLine: 'something' }),
    ).toThrow()
  })

  it('rejects over-long lines', () => {
    expect(() =>
      statusSummarySchema.parse({
        headerLine: 'a'.repeat(221),
        bodyLine: 'ok',
      }),
    ).toThrow()
  })
})
