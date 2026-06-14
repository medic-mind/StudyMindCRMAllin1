// Designed term-schedule PDF for a weekly class — a branded, paginated table
// (header band, columns, zebra rows) that the weekly reminder attaches and the
// group page previews. Dependency-free: built on the hand-rolled PDF writer
// (ADR 0021), so a self-hosted install needs no library or S3. When a class has
// an uploaded syllabus PDF the caller attaches that instead.

import { assemblePdf, escapePdfText, formatNumber as fmt } from '../email/pdf/pdf-writer'

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

/* -------------------------------------------------------------------------- */
/* Layout + palette                                                            */
/* -------------------------------------------------------------------------- */

const PAGE_W = 595
const PAGE_H = 842
const MARGIN = 48
const CONTENT_W = PAGE_W - MARGIN * 2

type RGB = readonly [number, number, number]
const BRAND: RGB = [0.118, 0.227, 0.541] // #1E3A8A
const WHITE: RGB = [1, 1, 1]
const WHITE_DIM: RGB = [0.85, 0.88, 0.96]
const INK: RGB = [0.12, 0.13, 0.16]
const MUTED: RGB = [0.42, 0.45, 0.5]
const HEADROW: RGB = [0.929, 0.949, 0.988] // #EDF1FC
const ZEBRA: RGB = [0.969, 0.976, 0.988] // #F7F9FC
const BORDER: RGB = [0.88, 0.9, 0.93]

const COL_WEEK_X = MARGIN
const COL_DATE_X = MARGIN + 56
const COL_TOPIC_X = MARGIN + 188
const COL_TOPIC_W = PAGE_W - MARGIN - COL_TOPIC_X
const TABLE_RIGHT = PAGE_W - MARGIN

const ROW_LINE = 12.5
const BOTTOM = 54

/* -------------------------------------------------------------------------- */
/* Content-stream op builders                                                  */
/* -------------------------------------------------------------------------- */

function col(c: RGB): string {
  return `${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])}`
}
function fill(x: number, y: number, w: number, h: number, c: RGB): string {
  return `${col(c)} rg\n${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re\nf`
}
function text(x: number, y: number, s: string, size: number, bold: boolean, c: RGB): string {
  return `${col(c)} rg\nBT /${bold ? 'F2' : 'F1'} ${fmt(size)} Tf ${fmt(x)} ${fmt(y)} Td (${escapePdfText(sanitise(s))}) Tj ET`
}

/** Map common Unicode punctuation to ASCII so it doesn't become "?" in WinAnsi. */
function sanitise(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ')
}

const CHAR_W = 0.52 // Helvetica avg width factor

function wrap(textStr: string, maxWidth: number, size: number): string[] {
  const maxChars = Math.max(6, Math.floor(maxWidth / (CHAR_W * size)))
  const words = sanitise(textStr).split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w
    if (cand.length > maxChars && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = cand
    }
  }
  if (cur) lines.push(cur)
  return lines
}

function ellipsise(s: string, maxWidth: number, size: number): string {
  const maxChars = Math.max(4, Math.floor(maxWidth / (CHAR_W * size)))
  const clean = sanitise(s)
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

/** Build a branded, paginated A4 PDF of the term's weekly classes. */
export function buildSchedulePdf(input: SchedulePdfInput): Buffer {
  const pages: string[][] = []
  let ops: string[] = []
  let y = 0
  let pageIndex = 0

  const tableHeader = (top: number): number => {
    ops.push(fill(MARGIN, top - 20, CONTENT_W, 20, HEADROW))
    ops.push(text(COL_WEEK_X + 4, top - 14, 'WEEK', 8.5, true, BRAND))
    ops.push(text(COL_DATE_X, top - 14, 'DATE', 8.5, true, BRAND))
    ops.push(text(COL_TOPIC_X, top - 14, 'TOPIC', 8.5, true, BRAND))
    return top - 20
  }

  const startPage = (): void => {
    ops = []
    pageIndex += 1
    if (pageIndex === 1) {
      // Full brand header on the first page.
      ops.push(fill(0, PAGE_H - 104, PAGE_W, 104, BRAND))
      ops.push(text(MARGIN, PAGE_H - 56, ellipsise(input.className, CONTENT_W, 22), 22, true, WHITE))
      ops.push(text(MARGIN, PAGE_H - 80, `${input.cohortName} · Weekly class schedule`, 11.5, false, WHITE_DIM))
      let metaY = PAGE_H - 128
      ops.push(text(MARGIN, metaY, `All sessions at ${sanitise(input.timeLabel)}`, 10, false, MUTED))
      if (input.zoomLink) {
        metaY -= 15
        ops.push(text(MARGIN, metaY, `Join (same link each week): ${ellipsise(input.zoomLink, CONTENT_W - 140, 10)}`, 10, false, MUTED))
      }
      y = tableHeader(metaY - 18)
    } else {
      // Slim continuation header on later pages.
      ops.push(fill(0, PAGE_H - 44, PAGE_W, 44, BRAND))
      ops.push(text(MARGIN, PAGE_H - 28, ellipsise(input.className, CONTENT_W, 13), 13, true, WHITE))
      ops.push(text(TABLE_RIGHT - 120, PAGE_H - 28, `${input.cohortName} (cont.)`, 9.5, false, WHITE_DIM))
      y = tableHeader(PAGE_H - 64)
    }
  }

  startPage()

  if (input.rows.length === 0) {
    ops.push(text(MARGIN, y - 24, 'The schedule will be shared soon.', 11, false, MUTED))
  }

  input.rows.forEach((row, i) => {
    const lines = wrap(row.topic || 'Topic to be confirmed', COL_TOPIC_W - 6, 9.5)
    const rowH = Math.max(1, lines.length) * ROW_LINE + 7
    if (y - rowH < BOTTOM) {
      ops.push(fill(MARGIN, y, CONTENT_W, 0.6, BORDER))
      pages.push(ops)
      startPage()
    }
    if (i % 2 === 1) ops.push(fill(MARGIN, y - rowH, CONTENT_W, rowH, ZEBRA))
    const baseline = y - 15
    ops.push(text(COL_WEEK_X + 4, baseline, String(row.weekNumber), 9.5, true, BRAND))
    ops.push(text(COL_DATE_X, baseline, ellipsise(row.dateLabel, COL_TOPIC_X - COL_DATE_X - 6, 9.5), 9.5, false, INK))
    lines.forEach((ln, li) => {
      ops.push(text(COL_TOPIC_X, baseline - li * ROW_LINE, ln, 9.5, false, INK))
    })
    y -= rowH
  })

  // Closing rule + footer on the final page.
  ops.push(fill(MARGIN, y, CONTENT_W, 0.6, BORDER))
  ops.push(text(MARGIN, 36, 'StudyMind — weekly live classes', 8.5, false, MUTED))
  pages.push(ops)

  // Object graph: 1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold, then a
  // (Page, Contents) pair per page (page k = obj 5+2k, contents 6+2k).
  const pageObjectNumbers = pages.map((_, i) => 5 + i * 2)
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]
  pages.forEach((pageOps, i) => {
    const content = pageOps.join('\n')
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`,
    )
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  return assemblePdf(objects)
}
