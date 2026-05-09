import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { exportReportPdf, renderReportPdf } from './pdf'

describe('renderReportPdf', () => {
  it('produces a buffer beginning with the PDF magic bytes', () => {
    const buf = renderReportPdf({
      title: 'Progress report',
      body: 'Hello world.',
      signedById: 'user_1',
      signedAt: new Date('2026-05-01'),
    })
    expect(buf.subarray(0, 5).toString('binary')).toBe('%PDF-')
    expect(buf.toString('binary')).toContain('%%EOF')
  })

  it('escapes parens in the body', () => {
    const buf = renderReportPdf({
      title: 't',
      body: 'attended (3 sessions)',
      signedById: null,
      signedAt: null,
    })
    expect(buf.toString('binary')).toContain('\\(3 sessions\\)')
  })
})

describe('exportReportPdf', () => {
  function makeFakeDb(state: 'draft' | 'signed' | 'rejected') {
    const reports = [
      {
        id: 'r1',
        state,
        contractId: 'c1',
        familyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
        draftText: '## Summary\nReport body',
        signedById: state === 'signed' ? 'user_1' : null,
        signedAt: state === 'signed' ? new Date('2026-05-01') : null,
        pdfS3Key: null,
      },
    ]
    const audit: Record<string, unknown>[] = []
    const db = {
      lAProgressReport: {
        findUniqueOrThrow: ({ where }: { where: { id: string } }) =>
          Promise.resolve(reports.find((r) => r.id === where.id)!),
        update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = reports.find((row) => row.id === where.id)!
          Object.assign(r, data)
          return Promise.resolve(r)
        },
      },
      auditLogEntry: {
        findFirst: () => Promise.resolve(null),
        create: ({ data }: { data: Record<string, unknown> }) => {
          audit.push(data)
          return Promise.resolve({ id: 'a1' })
        },
      },
    }
    return { db: db as never, reports, audit }
  }

  it('uploads to la-reports/{contract}/{period} and returns the key', async () => {
    const fake = makeFakeDb('signed')
    const uploaded: Array<{ key: string; bytes: number }> = []
    const result = await exportReportPdf(
      fake.db,
      { reportId: 'r1' },
      { actorId: 'u', requestId: 'r' },
      async ({ key, body }) => {
        uploaded.push({ key, bytes: body.byteLength })
        return { key }
      },
    )
    expect(result.key).toMatch(/^la-reports\/c1\/2026-04\/r1-[a-f0-9]+\.pdf$/)
    expect(uploaded[0]?.bytes).toBeGreaterThan(0)
  })

  it('refuses to export an unsigned report', async () => {
    const fake = makeFakeDb('draft')
    await expect(
      exportReportPdf(
        fake.db,
        { reportId: 'r1' },
        { actorId: 'u', requestId: 'r' },
        async ({ key }) => ({ key }),
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})
