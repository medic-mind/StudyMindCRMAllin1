// Render a Direct Debit recovery letter to a PDF (ADR 0045 amendment). The
// "threat" letters the team used to attach by hand are now generated from the
// SAME body that goes out as the email, personalised per recipient (name,
// amount, calculated CCJ court fee + interest already substituted upstream), so
// the customer gets a formal letter document alongside the email. Dependency-
// free (reuses the pure PDF writer); pure + deterministic.

import { renderPaginatedTextDocumentPdf, type PdfTextBlock } from '../email/pdf/pdf-writer'

const DEFAULT_COMPANY_NAME = 'Medic Mind'
const DEFAULT_COMPANY_LINES = [
  '16 Tottenhall Rd, London N13 6HX',
  'Tel: 020 3305 9593',
  'info@medicmind.co.uk · www.medicmind.co.uk',
]

export interface RecoveryLetterInput {
  /** Email subject / letter heading. */
  subject: string
  /** The rendered plain-text body (tokens already substituted). */
  body: string
  companyName?: string
  /** Letterhead lines under the company name (address, contact). */
  companyLines?: string[]
}

/**
 * Build a formal A4 letter PDF: a company letterhead, the subject as a heading,
 * then the body paragraphs (blank lines become spacers). Returns the PDF bytes.
 */
export function renderRecoveryLetterPdf(input: RecoveryLetterInput): Buffer {
  const blocks: PdfTextBlock[] = []
  blocks.push({ text: input.companyName ?? DEFAULT_COMPANY_NAME, bold: true, size: 16 })
  for (const line of input.companyLines ?? DEFAULT_COMPANY_LINES) {
    blocks.push({ text: line, size: 9 })
  }
  if (input.subject.trim()) {
    blocks.push({ text: input.subject.trim(), bold: true, size: 12, spacingBefore: 14 })
  }
  const paras = input.body.replace(/\r\n/g, '\n').split('\n')
  let first = true
  for (const para of paras) {
    if (para.trim() === '') {
      blocks.push({ text: '', spacingBefore: 4 })
    } else {
      blocks.push({ text: para, size: 11, spacingBefore: first ? 10 : 3 })
      first = false
    }
  }
  return renderPaginatedTextDocumentPdf(blocks)
}
