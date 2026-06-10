// Account-lifecycle email content: branded HTML/text templates plus the
// first-party credentials-PDF builder (ADR 0021). Pure — no I/O.

export type { WelcomeCredentials } from './types'
export { buildWelcomeEmail, escapeHtml, type RenderedEmail } from './templates'
export { buildWelcomePdf, WELCOME_PDF_FILENAME } from './welcome-pdf'
export { renderTextDocumentPdf, type PdfTextBlock } from './pdf/pdf-writer'
// Customer-facing Direct Debit sign-up emails (ADR 0038 amendment).
export {
  buildDirectDebitReminderEmail,
  buildDirectDebitSetupEmail,
  type DirectDebitReminderEmailInput,
  type DirectDebitSetupEmailInput,
} from './direct-debit-setup'
