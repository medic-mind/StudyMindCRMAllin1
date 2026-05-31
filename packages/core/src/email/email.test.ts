// Tests for the account-lifecycle email templates and the first-party PDF
// writer (ADR 0021).

import { describe, expect, it } from 'vitest'

import { buildWelcomeEmail, escapeHtml } from './templates'
import { renderTextDocumentPdf } from './pdf/pdf-writer'
import { buildWelcomePdf } from './welcome-pdf'

describe('renderTextDocumentPdf', () => {
  it('produces a structurally valid single-page PDF', () => {
    const pdf = renderTextDocumentPdf([
      { text: 'Title', bold: true, size: 20 },
      { text: 'A line of body text.' },
    ])
    const s = pdf.toString('latin1')
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(s).toContain('xref')
    expect(s).toContain('/BaseFont /Helvetica')
    // startxref must point at the xref keyword.
    const startxref = Number(s.match(/startxref\n(\d+)/)?.[1])
    expect(s.slice(startxref, startxref + 4)).toBe('xref')
  })

  it('escapes PDF-literal metacharacters', () => {
    const pdf = renderTextDocumentPdf([{ text: 'a (b) \\ c' }]).toString('latin1')
    expect(pdf).toContain('a \\(b\\) \\\\ c')
  })

  it('wraps long tokens instead of overflowing', () => {
    const longUrl = 'https://crm.studymind.co.uk/' + 'x'.repeat(300)
    // Should not throw and should still be a valid document.
    const pdf = renderTextDocumentPdf([{ text: longUrl }]).toString('latin1')
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
  })
})

describe('buildWelcomePdf', () => {
  it('embeds the email, temporary password and sign-in URL', () => {
    const pdf = buildWelcomePdf({
      name: 'Sam Tutor',
      email: 'sam@studymind.co.uk',
      temporaryPassword: 'Temp-Pass-2345',
      signInUrl: 'https://crm.studymind.co.uk/sign-in',
    }).toString('latin1')
    expect(pdf).toContain('sam@studymind.co.uk')
    expect(pdf).toContain('Temp-Pass-2345')
    expect(pdf).toContain('StudyMind CRM')
  })
})

describe('buildWelcomeEmail', () => {
  const base = {
    name: 'Sam Tutor',
    email: 'sam@studymind.co.uk',
    temporaryPassword: 'Temp-Pass-2345',
    signInUrl: 'https://crm.studymind.co.uk/sign-in',
    inviterName: 'Aashir',
  }

  it('renders a welcome email with credentials and a sign-in link', () => {
    const { subject, html, text } = buildWelcomeEmail(base)
    expect(subject).toMatch(/account is ready/i)
    expect(html).toContain('sam@studymind.co.uk')
    expect(html).toContain('Temp-Pass-2345')
    expect(html).toContain('https://crm.studymind.co.uk/sign-in')
    expect(text).toContain('Temporary password: Temp-Pass-2345')
  })

  it('switches wording for an admin-triggered reset', () => {
    const { subject, html } = buildWelcomeEmail({ ...base, isReset: true })
    expect(subject).toMatch(/reset/i)
    expect(html).toMatch(/reset/i)
  })

  it('escapes HTML in interpolated values', () => {
    const { html } = buildWelcomeEmail({ ...base, name: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('escapeHtml handles the core entities', () => {
    expect(escapeHtml('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;')
  })
})
