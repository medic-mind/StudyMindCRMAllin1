import { describe, expect, it } from 'vitest'

import { buildOutgoingEmail, plaintextToHtml } from './compose-html'

describe('plaintextToHtml', () => {
  it('wraps blank-line blocks in <p> and single newlines in <br>', () => {
    expect(plaintextToHtml('Hi there\nsecond line\n\nNew paragraph')).toBe(
      '<p style="margin:0 0 12px;white-space:pre-wrap">Hi there<br>second line</p>' +
        '<p style="margin:0 0 12px;white-space:pre-wrap">New paragraph</p>',
    )
  })

  it('escapes HTML so the typed body cannot inject markup', () => {
    expect(plaintextToHtml('<script>alert(1)</script> & "x"')).toBe(
      '<p style="margin:0 0 12px;white-space:pre-wrap">' +
        '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>',
    )
  })

  it('linkifies bare urls (after escaping)', () => {
    const out = plaintextToHtml('See https://studymind.co.uk/x now')
    expect(out).toContain('<a href="https://studymind.co.uk/x"')
    expect(out).toContain('>https://studymind.co.uk/x</a>')
  })
})

describe('buildOutgoingEmail', () => {
  it('no signature: plaintext body + html-rendered body', () => {
    const r = buildOutgoingEmail({ body: 'Hello' })
    expect(r.text).toBe('Hello')
    expect(r.html).toBe('<p style="margin:0 0 12px;white-space:pre-wrap">Hello</p>')
  })

  it('appends the signature to BOTH parts (html verbatim, text plain)', () => {
    const r = buildOutgoingEmail({
      body: 'Thanks',
      signatureHtml: '<p><b>Jane</b> · StudyMind</p>',
      signatureText: 'Jane · StudyMind',
    })
    expect(r.text).toBe('Thanks\n\nJane · StudyMind')
    expect(r.html).toBe(
      '<p style="margin:0 0 12px;white-space:pre-wrap">Thanks</p><br><p><b>Jane</b> · StudyMind</p>',
    )
  })

  it('ignores an empty/whitespace signature', () => {
    const r = buildOutgoingEmail({ body: 'Hi', signatureHtml: '   ', signatureText: ' ' })
    expect(r.text).toBe('Hi')
    expect(r.html).toBe('<p style="margin:0 0 12px;white-space:pre-wrap">Hi</p>')
  })
})
