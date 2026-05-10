import { describe, expect, it } from 'vitest'

import {
  buildProgressReportPrompt,
  PROGRESS_REPORT_VERSION,
  progressReportShape,
} from './progress-report'

describe('buildProgressReportPrompt', () => {
  it('stamps the version and includes attendance percentage', () => {
    const out = buildProgressReportPrompt({
      laName: 'LB Camden',
      contractReference: 'CAM-2026-001',
      learnerInitials: 'L.M.',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      sessions: [
        { sessionId: 's1', scheduledAt: '2026-04-05', state: 'delivered', hours: 2 },
        { sessionId: 's2', scheduledAt: '2026-04-12', state: 'no_show', hours: 0 },
      ],
      tutorNotes: [],
      safeguardingClosures: [],
      paymentStatus: 'on_track',
    })
    expect(out.promptVersion).toBe(PROGRESS_REPORT_VERSION)
    expect(out.user).toContain('Attendance: 50%')
  })
})

describe('progressReportShape', () => {
  it('accepts a long, well-formed report with Summary heading', () => {
    const text = `## Summary\n${'StudyMind delivered AP for the learner. '.repeat(40)}`
    expect(progressReportShape.parse(text)).toBeTypeOf('string')
  })

  it('rejects a report missing the Summary heading', () => {
    const text = `## Other\n${'a'.repeat(700)}`
    expect(() => progressReportShape.parse(text)).toThrow()
  })
})
