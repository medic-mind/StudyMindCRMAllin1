// Generated term-schedule PDF for a weekly class. Reuses the dependency-free
// PDF writer (ADR 0021) so a self-hosted install needs no library or S3. When a
// class has an uploaded syllabus PDF the caller attaches that instead.

import { renderPaginatedTextDocumentPdf, type PdfTextBlock } from '../email/pdf/pdf-writer'

export interface ScheduleRow {
  weekNumber: number
  /** Localised date, e.g. "Tue 9 Sep 2026". */
  dateLabel: string
  topic: string
}

export interface SchedulePdfInput {
  className: string
  timeLabel: string
  zoomLink: string | null
  cohortName: string
  rows: ScheduleRow[]
}

export const SCHEDULE_PDF_FILENAME = 'class-schedule.pdf'

/** Build a one-or-more page A4 PDF listing the term's weekly topics + dates. */
export function buildSchedulePdf(input: SchedulePdfInput): Buffer {
  const blocks: PdfTextBlock[] = [
    { text: input.className, bold: true, size: 18 },
    { text: `${input.cohortName} — weekly schedule`, size: 11, spacingBefore: 2 },
    { text: `Every week at ${input.timeLabel}`, size: 11 },
  ]
  if (input.zoomLink) {
    blocks.push({ text: `Join link: ${input.zoomLink}`, size: 10, spacingBefore: 2 })
  }
  blocks.push({ text: '', spacingBefore: 6 })

  if (input.rows.length === 0) {
    blocks.push({ text: 'The syllabus has not been set yet — your tutor will share it soon.' })
  }
  for (const row of input.rows) {
    blocks.push({
      text: `Week ${row.weekNumber} — ${row.dateLabel}`,
      bold: true,
      size: 11,
      spacingBefore: 6,
    })
    blocks.push({ text: row.topic || 'Topic to be confirmed', size: 11 })
  }

  return renderPaginatedTextDocumentPdf(blocks)
}
