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

/** Word-wrap `text` to the content width using an approximate Helvetica metric. */
function wrapText(text: string, size: number, bold: boolean): string[] {
  const charWidth = (bold ? 0.56 : 0.52) * size
  const maxChars = Math.max(8, Math.floor(CONTENT_WIDTH / charWidth))
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

/** Escape a string for a PDF literal `( … )`, encoding Latin-1 as octal. */
function escapePdfText(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0x3f
    if (ch === '(') out += '\\('
    else if (ch === ')') out += '\\)'
    else if (ch === '\\') out += '\\\\'
    else if (code >= 0x20 && code <= 0x7e) out += ch
    else if (code >= 0xa0 && code <= 0xff) out += `\\${code.toString(8).padStart(3, '0')}`
    else out += '?'
  }
  return out
}

function formatNumber(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}

/** Stitch object bodies into a PDF file with a correct xref table + trailer. */
function assemblePdf(objects: string[]): Buffer {
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
