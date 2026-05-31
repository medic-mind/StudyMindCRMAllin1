// Tests for the fresh-message MIME builder used by system email (ADR 0021).
// CLAUDE.md §14 — system email goes via Gmail OAuth, never a third-party API.

import { describe, expect, it } from 'vitest'

import { buildRawEmail } from './system-send'

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

describe('buildRawEmail', () => {
  it('builds a plain text/plain message when no html or attachments', () => {
    const raw = buildRawEmail({ to: ['a@studymind.co.uk'], subject: 'Hi', text: 'hello there' })
    const msg = decode(raw)
    expect(msg).toContain('To: a@studymind.co.uk')
    expect(msg).toContain('Subject: Hi')
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(msg).toContain('Content-Transfer-Encoding: base64')
    expect(msg).toContain(Buffer.from('hello there', 'utf8').toString('base64'))
  })

  it('builds multipart/alternative when html is present', () => {
    const raw = buildRawEmail({
      to: ['a@studymind.co.uk'],
      subject: 'Welcome',
      text: 'plain',
      html: '<p>rich</p>',
      boundarySeed: 'seed',
    })
    const msg = decode(raw)
    expect(msg).toContain('Content-Type: multipart/alternative;')
    expect(msg).toContain('Content-Type: text/html; charset="UTF-8"')
    expect(msg).toContain(Buffer.from('<p>rich</p>', 'utf8').toString('base64'))
  })

  it('wraps html + attachment in multipart/mixed with an alternative body', () => {
    const pdf = Buffer.from('%PDF-1.4 fake', 'utf8')
    const raw = buildRawEmail({
      to: ['new@studymind.co.uk'],
      subject: 'Your account',
      text: 'plain fallback',
      html: '<p>welcome</p>',
      attachments: [{ filename: 'login.pdf', content: pdf, contentType: 'application/pdf' }],
      boundarySeed: 'seed',
    })
    const msg = decode(raw)
    expect(msg).toContain('Content-Type: multipart/mixed;')
    expect(msg).toContain('Content-Type: multipart/alternative;')
    expect(msg).toContain('Content-Disposition: attachment; filename="login.pdf"')
    expect(msg).toContain('Content-Type: application/pdf; name="login.pdf"')
    expect(msg).toContain(pdf.toString('base64'))
  })

  it('strips header-injection characters from subject, recipients, and filenames', () => {
    const raw = buildRawEmail({
      to: ['a@studymind.co.uk\r\nBcc: evil@x.com'],
      subject: 'Hi\r\nX-Injected: 1',
      text: 'body',
      attachments: [{ filename: 'a\r\n"b.pdf', content: Buffer.from('x') }],
    })
    const msg = decode(raw)
    // CRLF in header values is collapsed to spaces, so the injected text can
    // never start a new header line.
    expect(msg).not.toContain('\r\nX-Injected:')
    expect(msg).not.toContain('\r\nBcc: evil@x.com')
    expect(msg).toContain('filename="a___b.pdf"')
  })
})
