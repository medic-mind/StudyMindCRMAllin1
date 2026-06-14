// Minimal, dependency-free PDF writer for short text documents (ADR 0021).
//
// Why hand-rolled rather than a library: the only PDF we generate is a one-page
// "credentials sheet" of plain text, and this codebase prefers small
// first-party wrappers over dependencies (CLAUDE.md §35 / §44.1 on
// supply-chain surface). This produces a valid
// PDF-1.4 file using the two built-in Helvetica fonts (no font embedding,
// no images), so it needs no third party and works offline.
//
// Output is pure ASCII: any non-ASCII input character is either WinAnsi
// octal-escaped (Latin-1 range) or replaced with '?', so a string's length
// equals its byte length and we can compute the cross-reference offsets
// directly. Single page only — callers keep documents short.

const PAGE_WIDTH = 595 // A4 portrait, points
const PAGE_HEIGHT = 842
const MARGIN_X = 64
const TOP_Y = PAGE_HEIGHT - 72
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2
const DEFAULT_SIZE = 11
const LINE_FACTOR = 1.45
const BOTTOM_Y = 64 // bottom margin (points) — paginate when a line would cross it

export interface PdfTextBlock {
  text: string
  /** Render in Helvetica-Bold rather than Helvetica. */
  bold?: boolean
  /** Font size in points. Default 11. */
  size?: number
  /** Extra vertical space (points) above this block. Default 0. */
  spacingBefore?: number
}

/** Render a sequence of text blocks to a single-page A4 PDF. */
export function renderTextDocumentPdf(blocks: PdfTextBlock[]): Buffer {
  const ops: string[] = []
  let y = TOP_Y

  for (const block of blocks) {
    const size = block.size ?? DEFAULT_SIZE
    const font = block.bold ? '/F2' : '/F1'
    y -= block.spacingBefore ?? 0
    const lines = block.text === '' ? [''] : wrapText(block.text, size, block.bold ?? false)
    for (const line of lines) {
      y -= size * LINE_FACTOR
      if (line !== '') {
        ops.push(
          `BT ${font} ${size} Tf ${MARGIN_X} ${formatNumber(y)} Td (${escapePdfText(line)}) Tj ET`,
        )
      }
    }
  }

  const content = ops.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]
  return assemblePdf(objects)
}

/**
 * Render text blocks across as many A4 pages as needed, breaking to a new page
 * when a line would cross the bottom margin. Used for variable-length reports
 * (e.g. the Aircall export) where a single page would truncate. Short documents
 * still produce exactly one page, so this is a superset of
 * `renderTextDocumentPdf`.
 */
export function renderPaginatedTextDocumentPdf(blocks: PdfTextBlock[]): Buffer {
  const pages: string[][] = []
  let ops: string[] = []
  let y = TOP_Y

  for (const block of blocks) {
    const size = block.size ?? DEFAULT_SIZE
    const font = block.bold ? '/F2' : '/F1'
    y -= block.spacingBefore ?? 0
    const lines = block.text === '' ? [''] : wrapText(block.text, size, block.bold ?? false)
    for (const line of lines) {
      y -= size * LINE_FACTOR
      if (y < BOTTOM_Y) {
        // Carry the current page and start a fresh one for this line.
        pages.push(ops)
        ops = []
        y = TOP_Y - size * LINE_FACTOR
      }
      if (line !== '') {
        ops.push(
          `BT ${font} ${size} Tf ${MARGIN_X} ${formatNumber(y)} Td (${escapePdfText(line)}) Tj ET`,
        )
      }
    }
  }
  pages.push(ops)

  // Object graph: 1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold, then a
  // (Page, Contents) pair per page. Page k is object (5 + 2k), its contents
  // (6 + 2k).
  const pageObjectNumbers = pages.map((_, i) => 5 + i * 2)
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]
  pages.forEach((pageOps, i) => {
    const contentsNumber = 6 + i * 2
    const content = pageOps.join('\n')
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentsNumber} 0 R >>`,
    )
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  return assemblePdf(objects)
}

// -----------------------------------------------------------------------------
// Branded single-page documents (ADR 0021). Adds colour to the otherwise
// text-only writer: a trust-blue header band with the brand wordmark, an accent
// rule, and an optional bordered "card" for key fields (e.g. login details), so
// the emailed PDFs match the branded HTML emails instead of looking like a bare
// text dump. Still dependency-free + ASCII (the byte-length invariant holds —
// colour/rect operators are ASCII).
// -----------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

const C_BRAND: Rgb = [0.043, 0.31, 0.541] // #0b4f8a
const C_ACCENT: Rgb = [0.184, 0.502, 0.761] // #2f80c2
const C_TEXT: Rgb = [0.122, 0.161, 0.2] // #1f2933
const C_MUTED: Rgb = [0.404, 0.447, 0.49] // #67717d
const C_WHITE: Rgb = [1, 1, 1]
const C_CARD_BG: Rgb = [0.969, 0.976, 0.984] // #f7f9fb
const C_CARD_BORDER: Rgb = [0.894, 0.906, 0.922] // #e4e7eb

const BAND_H = 92
const ACCENT_H = 4
const CARD_PAD = 18

export interface BrandedPdfField {
  label: string
  value: string
  /** Render the value larger/bold (e.g. a temporary password). */
  emphasise?: boolean
}

export interface BrandedPdfDoc {
  /** Header wordmark, e.g. "StudyMind CRM". */
  brandName: string
  headline: string
  /** Intro paragraphs above the field card. */
  intro?: string[]
  /** Key/value rows rendered inside a bordered card. */
  fields?: BrandedPdfField[]
  /** Paragraphs below the card. */
  notes?: string[]
  /** Small print at the foot of the page. */
  footer?: string
}

function fmtRgb(c: Rgb, op: 'rg' | 'RG'): string {
  return `${formatNumber(c[0])} ${formatNumber(c[1])} ${formatNumber(c[2])} ${op}`
}

function fillRectOp(x: number, y: number, w: number, h: number, color: Rgb): string {
  return `${fmtRgb(color, 'rg')} ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(w)} ${formatNumber(h)} re f`
}

function strokeRectOp(
  x: number,
  y: number,
  w: number,
  h: number,
  color: Rgb,
  lineWidth = 0.75,
): string {
  return `${fmtRgb(color, 'RG')} ${formatNumber(lineWidth)} w ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(w)} ${formatNumber(h)} re S`
}

function textOp(
  font: '/F1' | '/F2',
  size: number,
  x: number,
  y: number,
  text: string,
  color: Rgb,
): string {
  return `BT ${font} ${size} Tf ${fmtRgb(color, 'rg')} ${formatNumber(x)} ${formatNumber(y)} Td (${escapePdfText(text)}) Tj ET`
}

/** Render a branded, single-page A4 document (header band + accent + content). */
export function renderBrandedDocumentPdf(doc: BrandedPdfDoc): Buffer {
  const rectOps: string[] = []
  const textOps: string[] = []

  // Header band + accent rule + wordmark.
  rectOps.push(fillRectOp(0, PAGE_HEIGHT - BAND_H, PAGE_WIDTH, BAND_H, C_BRAND))
  rectOps.push(
    fillRectOp(0, PAGE_HEIGHT - BAND_H - ACCENT_H, PAGE_WIDTH, ACCENT_H, C_ACCENT),
  )
  textOps.push(
    textOp('/F2', 22, MARGIN_X, PAGE_HEIGHT - 56, doc.brandName, C_WHITE),
  )

  let y = PAGE_HEIGHT - BAND_H - ACCENT_H - 44

  // Headline.
  for (const line of wrapWidth(doc.headline, 19, true, CONTENT_WIDTH)) {
    y -= 19 * LINE_FACTOR
    textOps.push(textOp('/F2', 19, MARGIN_X, y, line, C_TEXT))
  }

  // Intro paragraphs.
  for (const para of doc.intro ?? []) {
    y -= 10
    for (const line of wrapWidth(para, 11, false, CONTENT_WIDTH)) {
      y -= 11 * LINE_FACTOR
      textOps.push(textOp('/F1', 11, MARGIN_X, y, line, C_TEXT))
    }
  }

  // Field card.
  if (doc.fields && doc.fields.length > 0) {
    y -= 22
    const cardTop = y
    let inner = cardTop - CARD_PAD
    const innerX = MARGIN_X + CARD_PAD
    const innerWidth = CONTENT_WIDTH - CARD_PAD * 2
    doc.fields.forEach((field, i) => {
      if (i > 0) inner -= 14
      inner -= 9 * LINE_FACTOR
      textOps.push(textOp('/F2', 9, innerX, inner, field.label.toUpperCase(), C_MUTED))
      const valueSize = field.emphasise ? 15 : 12
      const valueFont = field.emphasise ? '/F2' : '/F1'
      for (const line of wrapWidth(field.value, valueSize, field.emphasise ?? false, innerWidth)) {
        inner -= valueSize * LINE_FACTOR
        textOps.push(textOp(valueFont, valueSize, innerX, inner, line, C_TEXT))
      }
    })
    const cardBottom = inner - CARD_PAD
    const cardHeight = cardTop - cardBottom
    // Card drawn behind the field text (painter's model: rects emitted first).
    rectOps.push(fillRectOp(MARGIN_X, cardBottom, CONTENT_WIDTH, cardHeight, C_CARD_BG))
    rectOps.push(strokeRectOp(MARGIN_X, cardBottom, CONTENT_WIDTH, cardHeight, C_CARD_BORDER))
    y = cardBottom
  }

  // Notes.
  for (const para of doc.notes ?? []) {
    y -= 16
    for (const line of wrapWidth(para, 10, false, CONTENT_WIDTH)) {
      y -= 10 * LINE_FACTOR
      textOps.push(textOp('/F1', 10, MARGIN_X, y, line, C_MUTED))
    }
  }

  // Footer pinned near the bottom.
  if (doc.footer) {
    let fy = BOTTOM_Y
    for (const line of wrapWidth(doc.footer, 9, false, CONTENT_WIDTH).reverse()) {
      textOps.push(textOp('/F1', 9, MARGIN_X, fy, line, C_MUTED))
      fy += 9 * LINE_FACTOR
    }
  }

  const content = [...rectOps, ...textOps].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ]
  return assemblePdf(objects)
}

export interface BrandedReportPdf {
  /** Header wordmark, e.g. "StudyMind CRM". */
  brandName: string
  /** Report title shown in the header band. */
  title: string
  /** Optional subtitle (e.g. the period) shown under the title. */
  subtitle?: string
  /** Optional muted line under the band (e.g. "Generated …"). */
  generatedLine?: string
  /** Body content as text blocks (bold = section heading / emphasis). */
  blocks: PdfTextBlock[]
}

const REPORT_BAND_H = 78
const REPORT_BAND_H_CONT = 38

/**
 * Render a branded, **multi-page** report: a trust-blue header band with the
 * wordmark + title on every page (slim on continuations), an accent rule, and
 * paginated body blocks beneath. Bold blocks render as brand-coloured section
 * headings. Used for the Aircall report and any future analytics export so they
 * match the branded emails instead of looking like a text dump.
 */
export function renderBrandedReportPdf(doc: BrandedReportPdf): Buffer {
  const pages: string[][] = []
  let ops: string[] = []
  let y = 0

  const drawBand = (first: boolean): void => {
    const h = first ? REPORT_BAND_H : REPORT_BAND_H_CONT
    ops.push(fillRectOp(0, PAGE_HEIGHT - h, PAGE_WIDTH, h, C_BRAND))
    ops.push(fillRectOp(0, PAGE_HEIGHT - h - ACCENT_H, PAGE_WIDTH, ACCENT_H, C_ACCENT))
    if (first) {
      ops.push(textOp('/F2', 17, MARGIN_X, PAGE_HEIGHT - 32, doc.brandName, C_WHITE))
      ops.push(textOp('/F1', 12.5, MARGIN_X, PAGE_HEIGHT - 52, doc.title, C_WHITE))
      if (doc.subtitle) {
        ops.push(textOp('/F1', 10, MARGIN_X, PAGE_HEIGHT - 68, doc.subtitle, [0.85, 0.9, 0.97]))
      }
    } else {
      ops.push(textOp('/F2', 12, MARGIN_X, PAGE_HEIGHT - 25, doc.brandName, C_WHITE))
      ops.push(textOp('/F1', 10, PAGE_WIDTH - MARGIN_X - 120, PAGE_HEIGHT - 25, `${doc.title} (cont.)`, [0.85, 0.9, 0.97]))
    }
  }

  const startPage = (first: boolean): void => {
    ops = []
    drawBand(first)
    y = PAGE_HEIGHT - (first ? REPORT_BAND_H : REPORT_BAND_H_CONT) - ACCENT_H - 20
    if (first && doc.generatedLine) {
      y -= 12
      ops.push(textOp('/F1', 9, MARGIN_X, y, doc.generatedLine, C_MUTED))
      y -= 6
    }
  }

  startPage(true)

  for (const block of doc.blocks) {
    const size = block.size ?? DEFAULT_SIZE
    y -= block.spacingBefore ?? 0
    const heading = (block.bold ?? false) && size >= 12
    const colour: Rgb = heading ? C_BRAND : block.bold ? C_TEXT : size <= 9 ? C_MUTED : C_TEXT
    const font = block.bold ? '/F2' : '/F1'
    const lines = block.text === '' ? [''] : wrapWidth(block.text, size, block.bold ?? false, CONTENT_WIDTH)
    for (const line of lines) {
      y -= size * LINE_FACTOR
      if (y < BOTTOM_Y) {
        pages.push(ops)
        startPage(false)
        y -= size * LINE_FACTOR
      }
      if (line !== '') ops.push(textOp(font, size, MARGIN_X, y, line, colour))
    }
  }
  pages.push(ops)

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
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`,
    )
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  return assemblePdf(objects)
}

/** Word-wrap to a specific width (points). Generalises `wrapText`. */
function wrapWidth(text: string, size: number, bold: boolean, width: number): string[] {
  const charWidth = (bold ? 0.56 : 0.52) * size
  const maxChars = Math.max(8, Math.floor(width / charWidth))
  return wrapToMaxChars(text, maxChars)
}

/** Word-wrap `text` to the content width using an approximate Helvetica metric. */
function wrapText(text: string, size: number, bold: boolean): string[] {
  const charWidth = (bold ? 0.56 : 0.52) * size
  const maxChars = Math.max(8, Math.floor(CONTENT_WIDTH / charWidth))
  return wrapToMaxChars(text, maxChars)
}

/** Greedy word-wrap to a character budget, hard-breaking over-long tokens. */
function wrapToMaxChars(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    // Hard-break a single token longer than the line (e.g. a long URL).
    if (word.length > maxChars) {
      if (current) {
        lines.push(current)
        current = ''
      }
      for (let i = 0; i < word.length; i += maxChars) {
        lines.push(word.slice(i, i + maxChars))
      }
      continue
    }
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > maxChars) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}

// Unicode → WinAnsi (CP1252) byte for the 0x80–0x9F "specials" that are NOT in
// Latin-1 but ARE in the fonts' WinAnsiEncoding. Without this, smart quotes,
// dashes, bullets, the euro/trademark signs etc. fell through to "?" — the
// cause of the question marks across the PDFs. Mapping them to their WinAnsi
// byte makes them render correctly.
const WINANSI_SPECIALS: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
}

/**
 * Escape a string for a PDF literal `( … )`. ASCII passes through; common
 * Unicode punctuation maps to its WinAnsi byte (so it renders, not "?"); other
 * Latin-1 (0xA0–0xFF, incl. £ § © etc.) is octal-escaped; anything truly
 * outside the font (emoji, CJK) degrades to "?". The output is pure ASCII so
 * the xref byte-offset invariant in `assemblePdf` holds.
 */
export function escapePdfText(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0x3f
    if (ch === '(') out += '\\('
    else if (ch === ')') out += '\\)'
    else if (ch === '\\') out += '\\\\'
    else if (code >= 0x20 && code <= 0x7e) out += ch
    else {
      const byte = WINANSI_SPECIALS[code] ?? (code >= 0xa0 && code <= 0xff ? code : undefined)
      out += byte === undefined ? '?' : `\\${byte.toString(8).padStart(3, '0')}`
    }
  }
  return out
}

export function formatNumber(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

/** Stitch object bodies into a PDF file with a correct xref table + trailer. */
export function assemblePdf(objects: string[]): Buffer {
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefStart = body.length
  const size = objects.length + 1
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  // The whole document is ASCII (non-ASCII was escaped above), so latin1
  // encoding preserves the 1-char-per-byte invariant the offsets rely on.
  return Buffer.from(body + xref + trailer, 'latin1')
}
