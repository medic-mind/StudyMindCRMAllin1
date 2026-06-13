// Shared, polished email chrome for every transactional template (ADR 0021).
// Pure: input → HTML string. Inline styles only (email clients ignore <style>
// and Tailwind). One layout so the welcome, password-reset, and Direct Debit
// mails look like one branded family. House style: calm, trust-blue, no emoji.

const COLOR_HEADER = '#0b4f8a'
const COLOR_TEXT = '#1f2933'
const COLOR_MUTED = '#6b7280'
const COLOR_BORDER = '#e4e7eb'
const COLOR_ACCENT = '#2f80c2'
const COLOR_SHELL = '#eef2f7'
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

/** Primary call-to-action button. */
export function emailButton(href: string, label: string): string {
  return (
    `<a href="${escapeHtml(href)}" ` +
    `style="display:inline-block;background:${COLOR_HEADER};color:#ffffff;text-decoration:none;` +
    `font-weight:600;font-size:15px;padding:13px 24px;border-radius:8px;` +
    `box-shadow:0 1px 2px rgba(8,61,107,0.25);">${escapeHtml(label)}</a>`
  )
}

export interface EmailLayoutOptions {
  /** Header wordmark — "StudyMind" (customer) or "StudyMind CRM" (staff). */
  brandName: string
  heading: string
  bodyHtml: string
  /** Inbox preview line (hidden in the body). Defaults to the heading. */
  preheader?: string
  /** Small print at the foot — context for why this email was received. */
  footerNote: string
  /** Optional hosted logo URL; replaces the wordmark when set. */
  logoUrl?: string | null
}

function header(brandName: string, logoUrl?: string | null): string {
  const inner = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(brandName)}" height="30" ` +
      `style="height:30px;width:auto;display:block;border:0;outline:none;text-decoration:none;">`
    : `<div style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:-0.2px;">${escapeHtml(brandName)}</div>`
  return (
    `<div style="background:${COLOR_HEADER};border-radius:12px 12px 0 0;padding:22px 30px;">${inner}</div>` +
    `<div style="height:3px;background:${COLOR_ACCENT};"></div>`
  )
}

export function renderEmailLayout(opts: EmailLayoutOptions): string {
  const preheader = (opts.preheader ?? opts.heading).slice(0, 140)
  return `<!DOCTYPE html>
<html lang="en-GB">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${COLOR_SHELL};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLOR_SHELL};">${escapeHtml(preheader)}</div>
  <div style="max-width:580px;margin:0 auto;padding:28px 14px;font-family:${FONT_STACK};color:${COLOR_TEXT};">
    ${header(opts.brandName, opts.logoUrl)}
    <div style="background:#ffffff;border:1px solid ${COLOR_BORDER};border-top:0;border-radius:0 0 12px 12px;padding:30px;">
      <h1 style="margin:0 0 18px;font-size:20px;line-height:1.3;font-weight:700;color:${COLOR_TEXT};letter-spacing:-0.2px;">${escapeHtml(opts.heading)}</h1>
      ${opts.bodyHtml}
    </div>
    <p style="margin:18px 6px 0;font-size:12px;color:${COLOR_MUTED};line-height:1.5;">
      ${escapeHtml(opts.footerNote)}
    </p>
    <p style="margin:8px 6px 0;font-size:12px;color:${COLOR_MUTED};">${escapeHtml(opts.brandName)}</p>
  </div>
</body>
</html>`
}
