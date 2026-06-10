// Customer-facing Direct Debit sign-up emails (ADR 0038 amendment).
// Pure builders: input → { subject, html, text }. No I/O — the tRPC layer
// and the reminder cron compose these and send via Gmail (sendSystemEmail,
// CLAUDE.md §14 — never Resend). Inline styles only.
//
// House style (CLAUDE.md §4): warm, professional, specific, British English.
// These go to parents — no jargon, no alarm; the Direct Debit Guarantee is
// stated plainly because that's what a careful company does.

import { escapeHtml, type RenderedEmail } from './templates'

const COLOR_HEADER = '#0b4f8a'
const COLOR_TEXT = '#1f2933'
const COLOR_MUTED = '#52606d'
const COLOR_BORDER = '#e4e7eb'
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/** Customer-facing shell — brand header reads "StudyMind", not the CRM. */
function customerLayout(opts: { heading: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f7fa;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:${FONT_STACK};color:${COLOR_TEXT};">
    <div style="background:${COLOR_HEADER};border-radius:10px 10px 0 0;padding:20px 28px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.2px;">StudyMind</div>
    </div>
    <div style="background:#ffffff;border:1px solid ${COLOR_BORDER};border-top:0;border-radius:0 0 10px 10px;padding:28px;">
      <h1 style="margin:0 0 16px;font-size:19px;line-height:1.3;color:${COLOR_TEXT};">${escapeHtml(opts.heading)}</h1>
      ${opts.bodyHtml}
    </div>
    <p style="margin:16px 4px 0;font-size:12px;color:${COLOR_MUTED};line-height:1.5;">
      Your payments are protected by the Direct Debit Guarantee and collected by GoCardless on
      behalf of StudyMind. If you were not expecting this email, please reply and let us know.
    </p>
  </div>
</body>
</html>`
}

function button(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${COLOR_HEADER};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px;">${escapeHtml(label)}</a>`
}

export interface DirectDebitSetupEmailInput {
  /** Parent's first name; falls back to a neutral greeting when blank. */
  firstName?: string | null
  /** The durable CRM setup URL (NOT a raw GoCardless flow URL). */
  setupUrl: string
  /** Optional plan wording, e.g. "Weekly tuition — 2 hours". */
  description?: string | null
  /** Whole days the link remains valid. */
  validForDays: number
}

export function buildDirectDebitSetupEmail(
  input: DirectDebitSetupEmailInput,
): RenderedEmail {
  const hello = `Hello${input.firstName?.trim() ? ` ${input.firstName.trim()}` : ''},`
  const planLine = input.description?.trim()
    ? `To get started with ${input.description.trim()}, the last step is to set up your Direct Debit.`
    : 'The last step to get started is to set up your Direct Debit.'

  const subject = 'Set up your Direct Debit with StudyMind'
  const bodyHtml = `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">${escapeHtml(hello)}</p>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">Thank you for choosing StudyMind. ${escapeHtml(planLine)}</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;">
      It takes about two minutes on a secure page run by GoCardless, our payment provider.
      You will always receive notice by email before any payment is collected, and you can
      cancel at any time through your bank.
    </p>
    <p style="margin:0 0 8px;">${button(input.setupUrl, 'Set up my Direct Debit')}</p>
    <p style="margin:14px 0 0;font-size:13px;color:${COLOR_MUTED};word-break:break-all;">
      Or paste this link into your browser: ${escapeHtml(input.setupUrl)}
    </p>
    <p style="margin:14px 0 0;font-size:13px;color:${COLOR_MUTED};">
      This link is personal to you and valid for ${input.validForDays} days.
      If you have any questions, simply reply to this email and the team will be happy to help.
    </p>`

  const text = [
    hello,
    '',
    `Thank you for choosing StudyMind. ${planLine}`,
    '',
    'It takes about two minutes on a secure page run by GoCardless, our payment provider. ' +
      'You will always receive notice by email before any payment is collected, and you can ' +
      'cancel at any time through your bank.',
    '',
    `Set up your Direct Debit: ${input.setupUrl}`,
    '',
    `This link is personal to you and valid for ${input.validForDays} days. ` +
      'If you have any questions, simply reply to this email and the team will be happy to help.',
    '',
    '— The StudyMind team',
  ].join('\n')

  return {
    subject,
    html: customerLayout({ heading: 'Set up your Direct Debit', bodyHtml }),
    text,
  }
}

export interface DirectDebitReminderEmailInput extends DirectDebitSetupEmailInput {
  /** Whole days left before the link expires (floor, min 1 shown). */
  daysRemaining: number
}

export function buildDirectDebitReminderEmail(
  input: DirectDebitReminderEmailInput,
): RenderedEmail {
  const hello = `Hello${input.firstName?.trim() ? ` ${input.firstName.trim()}` : ''},`
  const days = Math.max(1, input.daysRemaining)
  const planSuffix = input.description?.trim() ? ` for ${input.description.trim()}` : ''

  const subject = 'A gentle reminder — your StudyMind Direct Debit'
  const bodyHtml = `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">${escapeHtml(hello)}</p>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">
      Just a gentle reminder that your Direct Debit${escapeHtml(planSuffix)} has not been set up yet.
      It takes about two minutes on a secure GoCardless page.
    </p>
    <p style="margin:0 0 8px;">${button(input.setupUrl, 'Set up my Direct Debit')}</p>
    <p style="margin:14px 0 0;font-size:13px;color:${COLOR_MUTED};word-break:break-all;">
      Or paste this link into your browser: ${escapeHtml(input.setupUrl)}
    </p>
    <p style="margin:14px 0 0;font-size:13px;color:${COLOR_MUTED};">
      The link stays valid for another ${days} ${days === 1 ? 'day' : 'days'}. If you have already
      completed it, or anything is unclear, just reply to this email and we will sort it out.
    </p>`

  const text = [
    hello,
    '',
    `Just a gentle reminder that your Direct Debit${planSuffix} has not been set up yet. ` +
      'It takes about two minutes on a secure GoCardless page.',
    '',
    `Set up your Direct Debit: ${input.setupUrl}`,
    '',
    `The link stays valid for another ${days} ${days === 1 ? 'day' : 'days'}. If you have already ` +
      'completed it, or anything is unclear, just reply to this email and we will sort it out.',
    '',
    '— The StudyMind team',
  ].join('\n')

  return {
    subject,
    html: customerLayout({ heading: 'Your Direct Debit is not set up yet', bodyHtml }),
    text,
  }
}
