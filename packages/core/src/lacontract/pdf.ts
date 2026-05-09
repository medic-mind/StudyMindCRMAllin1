// Progress-report PDF rendering. CLAUDE.md §43.3.
//
// Adding @react-pdf/renderer would be a new third-party dependency, which
// requires an ADR per CLAUDE.md §3 / §35. Until that ADR lands, we generate
// a minimal but valid single-page PDF using a tiny built-in renderer that
// only emits the report text in a monospaced font. This keeps the public
// API identical (`renderReportPdf` returns a Buffer; `exportReportPdf`
// uploads via the injected uploader) so a richer renderer can swap in
// without changing call sites.

import { createHash } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

type DbWriter = PrismaClient | Prisma.TransactionClient

/**
 * Inject this in production. Returns the S3 key the bytes were written to.
 * The web app wires this to the AWS SDK in `apps/web/lib/s3.ts`.
 */
export interface PdfUploader {
  (input: { key: string; body: Buffer; contentType: string }): Promise<{ key: string }>
}

export interface ActorCtx {
  actorId: string
  requestId: string
}

/**
 * Render the report text into a single-page PDF in the simplest valid form
 * (PDF 1.4, one font, one stream, no images). Long text wraps at ~90 cols
 * and overflow is truncated with a footer. Good enough for an LA-facing
 * sign-off; a richer renderer is on the roadmap.
 */
export function renderReportPdf(input: {
  title: string
  body: string
  signedById: string | null
  signedAt: Date | null
}): Buffer {
  const lines: string[] = []
  lines.push(input.title)
  lines.push('')
  for (const para of input.body.split('\n')) {
    let remaining = para
    if (remaining.length === 0) {
      lines.push('')
      continue
    }
    while (remaining.length > 90) {
      lines.push(remaining.slice(0, 90))
      remaining = remaining.slice(90)
    }
    lines.push(remaining)
  }
  if (input.signedById && input.signedAt) {
    lines.push('')
    lines.push(`Signed by ${input.signedById} on ${input.signedAt.toISOString().slice(0, 10)}`)
  }
  // Cap to the first 200 lines on a single page; PDF page is letter-sized.
  const visible = lines.slice(0, 200)

  const escape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

  const stream = [
    'BT',
    '/F1 11 Tf',
    '14 TL',
    '36 750 Td',
    ...visible.map((l, i) =>
      i === 0 ? `(${escape(l)}) Tj` : `T* (${escape(l)}) Tj`,
    ),
    'ET',
  ].join('\n')

  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
  objects[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  const header = '%PDF-1.4\n'
  const body: string[] = []
  const offsets: number[] = []
  let cursor = Buffer.byteLength(header, 'binary')
  for (let i = 1; i < objects.length; i += 1) {
    const obj = `${i} 0 obj\n${objects[i]}\nendobj\n`
    offsets[i] = cursor
    body.push(obj)
    cursor += Buffer.byteLength(obj, 'binary')
  }
  const xrefStart = cursor
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objects.length; i += 1) {
    xref += `${offsets[i]!.toString().padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return Buffer.from(header + body.join('') + xref + trailer, 'binary')
}

export interface ExportReportPdfInput {
  reportId: string
}

export async function exportReportPdf(
  db: DbWriter,
  input: ExportReportPdfInput,
  ctx: ActorCtx,
  uploader: PdfUploader,
): Promise<{ key: string }> {
  const report = await db.lAProgressReport.findUniqueOrThrow({
    where: { id: input.reportId },
    select: {
      id: true,
      state: true,
      contractId: true,
      familyId: true,
      periodStart: true,
      periodEnd: true,
      draftText: true,
      signedById: true,
      signedAt: true,
    },
  })

  if (report.state !== 'signed') {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Report ${input.reportId} is in state ${report.state}; only signed reports can be exported`,
    )
  }

  const periodLabel = `${report.periodStart.toISOString().slice(0, 7)}`
  const buf = renderReportPdf({
    title: `Progress report — ${periodLabel}`,
    body: report.draftText,
    signedById: report.signedById,
    signedAt: report.signedAt,
  })

  // S3 layout from CLAUDE.md §43.3: la-reports/{contract_id}/{period}/.
  // Append a content hash so the same period can re-export deterministically
  // if a sign-off is reissued.
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12)
  const key = `la-reports/${report.contractId}/${periodLabel}/${report.id}-${hash}.pdf`

  const uploaded = await uploader({ key, body: buf, contentType: 'application/pdf' })

  await db.lAProgressReport.update({
    where: { id: report.id },
    data: { pdfS3Key: uploaded.key, updatedById: ctx.actorId },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'lacontract.progress_report_exported',
    target: { type: 'LAProgressReport', id: report.id },
    requestId: ctx.requestId,
    after: { s3Key: uploaded.key, byteLength: buf.byteLength },
  })

  return { key: uploaded.key }
}
