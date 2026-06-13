// Branded transactional email templates for the user-management flows
// (ADR 0021). Pure builders: input → { subject, html, text }. No I/O — the
// admin router composes these with the credentials PDF and sends them via
// Gmail (sendSystemEmail). Inline styles only (email clients ignore <style>/Tailwind).
//
// House style (CLAUDE.md §4): warm, professional, specific. No emoji.

import { emailButton, escapeHtml, renderEmailLayout } from './layout'
import type { WelcomeCredentials } from './types'

// Re-export so existing importers (e.g. direct-debit-setup) keep working.
export { escapeHtml }

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

const COLOR_TEXT = '#1f2933'
const COLOR_MUTED = '#52606d'
const COLOR_BORDER = '#e4e7eb'

const STAFF_FOOTER =
  'You are receiving this because a StudyMind CRM account was created or updated for this address. If you were not expecting it, please contact your administrator.'

function credentialsBox(email: string, temporaryPassword: string): string {
  const row = (label: string, value: string, mono = false) =>
    `<tr>
      <td style="padding:6px 0;font-size:13px;color:${COLOR_MUTED};width:170px;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:6px 0;font-size:14px;color:${COLOR_TEXT};${mono ? "font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-weight:700;" : ''}">${escapeHtml(value)}</td>
    </tr>`
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:18px 0;border:1px solid ${COLOR_BORDER};border-radius:8px;padding:6px 16px;background:#f9fafb;">
    ${row('Email / username', email)}
    ${row('Temporary password', temporaryPassword, true)}
  </table>`
}

/**
 * Welcome email for an admin-created account, or the notice for an
 * admin-triggered password reset (`isReset`). The same temporary password is
 * also delivered in the attached PDF.
 */
export function buildWelcomeEmail(input: WelcomeCredentials): RenderedEmail {
  const name = (input.name ?? '').trim()
  const inviter = (input.inviterName ?? '').trim()
  const hello = `Hello${name ? ` ${name}` : ''},`

  const subject = input.isReset
    ? 'Your StudyMind CRM password has been reset'
    : 'Your StudyMind CRM account is ready'
  const heading = input.isReset ? 'Your password has been reset' : 'Welcome to StudyMind CRM'
  const intro = input.isReset
    ? `${inviter ? `${escapeHtml(inviter)} has reset` : 'An administrator has reset'} the password on your StudyMind CRM account. Use the temporary password below to sign in.`
    : `${inviter ? `${escapeHtml(inviter)} has created` : 'An administrator has created'} a StudyMind CRM account for you. Use the details below to sign in for the first time.`

  const bodyHtml = `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">${escapeHtml(hello)}</p>
    <p style="margin:0 0 8px;font-size:15px;line-height:1.55;color:${COLOR_TEXT};">${intro}</p>
    ${credentialsBox(input.email, input.temporaryPassword)}
    <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:${COLOR_MUTED};">
      For your security you will be asked to choose your own password the first time you sign in.
      This temporary password can only be used once. A copy of these details is attached as a PDF.
    </p>
    <p style="margin:0 0 8px;">${emailButton(input.signInUrl, 'Sign in to StudyMind CRM')}</p>
    <p style="margin:14px 0 0;font-size:13px;color:${COLOR_MUTED};word-break:break-all;">
      Or paste this link into your browser: ${escapeHtml(input.signInUrl)}
    </p>`

  const text = [
    hello,
    '',
    input.isReset
      ? `${inviter || 'An administrator'} has reset the password on your StudyMind CRM account.`
      : `${inviter || 'An administrator'} has created a StudyMind CRM account for you.`,
    '',
    `Sign-in address: ${input.signInUrl}`,
    `Email / username: ${input.email}`,
    `Temporary password: ${input.temporaryPassword}`,
    '',
    'You will be asked to choose your own password the first time you sign in. ' +
      'This temporary password can only be used once. A copy of these details is attached as a PDF.',
    '',
    'If you were not expecting this email, please contact your administrator.',
    '',
    '— StudyMind CRM',
  ].join('\n')

  return {
    subject,
    html: renderEmailLayout({
      brandName: 'StudyMind CRM',
      heading,
      bodyHtml,
      preheader: input.isReset
        ? 'Your temporary password is inside.'
        : 'Your sign-in details are inside.',
      footerNote: STAFF_FOOTER,
    }),
    text,
  }
}
