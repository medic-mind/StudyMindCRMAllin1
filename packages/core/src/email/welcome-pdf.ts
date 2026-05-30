// Builds the "welcome credentials" PDF attached to the account-created and
// admin-reset emails (ADR 0021). One page, plain text, via the first-party
// pdf-writer. The temporary password is shown here and in the email body;
// it is never logged.

import { renderTextDocumentPdf, type PdfTextBlock } from './pdf/pdf-writer'
import type { WelcomeCredentials } from './types'

/** Suggested attachment filename for the credentials PDF. */
export const WELCOME_PDF_FILENAME = 'StudyMind-CRM-login-details.pdf'

export function buildWelcomePdf(input: WelcomeCredentials): Buffer {
  const greetingName = (input.name ?? '').trim()
  const inviter = (input.inviterName ?? '').trim()
  const intro = input.isReset
    ? 'Your StudyMind CRM password has been reset by an administrator. Use the temporary password below to sign in.'
    : 'An account has been created for you on the StudyMind All in One CRM. Use the details below to sign in for the first time.'

  const blocks: PdfTextBlock[] = [
    { text: 'StudyMind CRM', bold: true, size: 22 },
    {
      text: input.isReset ? 'Your password has been reset' : 'Welcome — your account is ready',
      size: 13,
      spacingBefore: 4,
    },
    { text: `Hello${greetingName ? ` ${greetingName}` : ''},`, size: 11, spacingBefore: 22 },
    { text: intro, size: 11, spacingBefore: 8 },

    { text: 'Sign-in address', bold: true, size: 11, spacingBefore: 20 },
    { text: input.signInUrl, size: 11, spacingBefore: 2 },

    { text: 'Email / username', bold: true, size: 11, spacingBefore: 12 },
    { text: input.email, size: 11, spacingBefore: 2 },

    { text: 'Temporary password', bold: true, size: 11, spacingBefore: 12 },
    { text: input.temporaryPassword, bold: true, size: 15, spacingBefore: 2 },

    {
      text:
        'You will be asked to choose your own password the first time you sign in. ' +
        'This temporary password can only be used once.',
      size: 11,
      spacingBefore: 22,
    },
    {
      text:
        'Please keep these details private. If you were not expecting this email, ' +
        `contact ${inviter || 'your administrator'} or reply to let us know.`,
      size: 11,
      spacingBefore: 10,
    },
    { text: '— StudyMind CRM', size: 11, spacingBefore: 24 },
  ]

  return renderTextDocumentPdf(blocks)
}
