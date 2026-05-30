// Branded transactional email templates for the user-management flows
// (ADR 0021). Pure builders: input → { subject, html, text }. No I/O — the
// admin router composes these with the credentials PDF and sends them via
// Gmail (sendSystemEmail). Inline styles only (email clients ignore <style>/Tailwind).
//
// House style (CLAUDE.md §4): warm, professional, specific. No emoji.

import type { WelcomeCredentials } from './types'

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

// A calm trust-blue header on a light shell. These values are intentionally
// inline (transactional email cannot read the product's Tailwind tokens).
const COLOR_HEADER = '#0b4f8a'
const COLOR_TEXT = '#1f2933'
const COLOR_MUTED = '#52606d'
const COLOR_BORDER = '#e4e7eb'
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function layout(opts: { heading: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f7fa;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:${FONT_STACK};color:${COLOR_TEXT};">
    <div style="background:${COLOR_HEADER};border-radius:10px 10px 0 0;padding:20px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.2px;">StudyMind CRM</div>
    </div>
    <div style="background:#ffffff;border:1px solid ${COLOR_BORDER};border-top:0;border-radius:0 0 10px 10px;padding:28px;">
      <h1 style="margin:0 0 16px;font-size:19px;line-height:1.3;color:${COLOR_TEXT};">${escapeHtml(opts.heading)}</h1>
      ${opts.bodyHtml}
    </div>
    <p style="margin:16px 4px 0;font-size:12px;color:${COLOR_MUTED};line-height:1.5;">
      You are receiving this because a StudyMind CRM account was created or updated for this address.
      If you were not expecting it, please contact your administrator.
    </p>
  </div>
</body>
</html>`
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${COLOR_HEADER};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px;">${escapeHtml(label)}</a>`
}

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
    <p style="margin:0 0 8px;">${button(input.signInUrl, 'Sign in to StudyMind CRM')}</p>
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

  return { subject, html: layout({ heading, bodyHtml }), text }
}
