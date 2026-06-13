import { describe, expect, it } from 'vitest'

import { prepareEmailHtml, sanitizeEmailHtml, MAX_EMAIL_HTML_BYTES } from './html-email'

describe('sanitizeEmailHtml', () => {
  it('removes script blocks and standalone script tags', () => {
    expect(sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>')
    expect(sanitizeEmailHtml('<script src="evil.js"></script><p>x</p>')).toBe('<p>x</p>')
  })

  it('removes iframe/object/embed/base/meta/link', () => {
    expect(sanitizeEmailHtml('<iframe src="x"></iframe><p>a</p>')).toBe('<p>a</p>')
    expect(sanitizeEmailHtml('<meta http-equiv="refresh" content="0;url=x"><p>a</p>')).toBe(
      '<p>a</p>',
    )
    expect(sanitizeEmailHtml('<base href="http://evil/"><p>a</p>')).toBe('<p>a</p>')
  })

  it('strips inline event handlers', () => {
    expect(sanitizeEmailHtml('<img src="x" onerror="alert(1)">')).toBe('<img src="x">')
    expect(sanitizeEmailHtml("<a onclick='steal()'>x</a>")).toBe('<a>x</a>')
  })

  it('neutralises javascript: urls', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).toContain('<a href="#">x</a>')
  })

  it('KEEPS inline styles, tables, images and links (Gmail-identical look)', () => {
    const html =
      '<table style="width:100%"><tr><td style="color:red">Hi</td></tr></table><img src="https://cdn/x.png"><a href="https://x">link</a>'
    expect(sanitizeEmailHtml(html)).toBe(html)
  })
})

describe('prepareEmailHtml', () => {
  it('returns null for empty / whitespace', () => {
    expect(prepareEmailHtml(null)).toBeNull()
    expect(prepareEmailHtml('')).toBeNull()
    expect(prepareEmailHtml('   <div> </div> ')).toBe('<div> </div>')
  })

  it('returns null when over the byte cap (falls back to plaintext)', () => {
    const huge = '<p>' + 'a'.repeat(MAX_EMAIL_HTML_BYTES) + '</p>'
    expect(prepareEmailHtml(huge)).toBeNull()
  })

  it('sanitises and trims under the cap', () => {
    expect(prepareEmailHtml('  <p>hi</p><script>x()</script>  ')).toBe('<p>hi</p>')
  })
})
