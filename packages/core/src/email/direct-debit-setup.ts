// Customer-facing Direct Debit sign-up emails (ADR 0038 amendment).
// Pure builders: input → { subject, html, text }. No I/O — the tRPC layer
// and the reminder cron compose these and send via Gmail (sendSystemEmail,
// CLAUDE.md §14 — never Resend). Inline styles only.
//
// House style (CLAUDE.md §4): warm, professional, specific, British English.
// These go to parents — no jargon, no alarm; the Direct Debit Guarantee is
// stated plainly because that's what a careful company does.

import { emailButton, renderEmailLayout } from './layout'
import { escapeHtml, type RenderedEmail } from './templates'

const COLOR_MUTED = '#52606d'

const DD_FOOTER =
  'Your payments are protected by the Direct Debit Guarantee and collected by GoCardless on behalf of StudyMind. If you were not expecting this email, please reply and let us know.'

/** Customer-facing shell — brand header reads "StudyMind", not the CRM. */
function customerLayout(opts: {
  heading: string
  bodyHtml: string
  preheader?: string
}): string {
  return renderEmailLayout({
    brandName: 'StudyMind',
    heading: opts.heading,
    bodyHtml: opts.bodyHtml,
    ...(opts.preheader ? { preheader: opts.preheader } : {}),
    footerNote: DD_FOOTER,
  })
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
    <p style="margin:0 0 8px;">${emailButton(input.setupUrl, 'Set up my Direct Debit')}</p>
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
    html: customerLayout({
      heading: 'Set up your Direct Debit',
      bodyHtml,
      preheader: 'Two minutes on a secure GoCardless page to get started.',
    }),
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
    <p style="margin:0 0 8px;">${emailButton(input.setupUrl, 'Set up my Direct Debit')}</p>
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
    html: customerLayout({
      heading: 'Your Direct Debit is not set up yet',
      bodyHtml,
      preheader: 'A gentle reminder — it only takes two minutes.',
    }),
    text,
  }
}
