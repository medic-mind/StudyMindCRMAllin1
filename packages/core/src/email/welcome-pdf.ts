// Builds the "welcome credentials" PDF attached to the account-created and
// admin-reset emails (ADR 0021). One branded page via the first-party
// pdf-writer — a trust-blue header band, the sign-in details in a bordered
// card, matching the HTML email. The temporary password is shown here and in
// the email body; it is never logged.

import { renderBrandedDocumentPdf } from './pdf/pdf-writer'
import type { WelcomeCredentials } from './types'

/** Suggested attachment filename for the credentials PDF. */
export const WELCOME_PDF_FILENAME = 'StudyMind-CRM-login-details.pdf'

export function buildWelcomePdf(input: WelcomeCredentials): Buffer {
  const greetingName = (input.name ?? '').trim()
  const inviter = (input.inviterName ?? '').trim()
  const intro = input.isReset
    ? 'Your StudyMind CRM password has been reset by an administrator. Use the temporary password below to sign in.'
    : 'An account has been created for you on the StudyMind All in One CRM. Use the details below to sign in for the first time.'

  return renderBrandedDocumentPdf({
    brandName: 'StudyMind CRM',
    headline: input.isReset
      ? 'Your password has been reset'
      : 'Welcome — your account is ready',
    intro: [`Hello${greetingName ? ` ${greetingName}` : ''},`, intro],
    fields: [
      { label: 'Sign-in address', value: input.signInUrl },
      { label: 'Email / username', value: input.email },
      { label: 'Temporary password', value: input.temporaryPassword, emphasise: true },
    ],
    notes: [
      'You will be asked to choose your own password the first time you sign in. ' +
        'This temporary password can only be used once.',
      'Please keep these details private. If you were not expecting this email, ' +
        `contact ${inviter || 'your administrator'} or reply to let us know.`,
    ],
    footer: 'StudyMind CRM — the single pane of glass for everything StudyMind does.',
  })
}
