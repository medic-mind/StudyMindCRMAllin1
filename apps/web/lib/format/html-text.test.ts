// Tests for the HTML → readable-text extraction used on email message
// bodies in the comms centre and contact-page Trengo threads.

import { describe, expect, it } from 'vitest'

import { displayMessageBody, htmlToText, looksLikeHtml } from './html-text'

describe('looksLikeHtml', () => {
  it('detects tags and entities', () => {
    expect(looksLikeHtml('<p>Hello</p>')).toBe(true)
    expect(looksLikeHtml('Fish &amp; Chips')).toBe(true)
    expect(looksLikeHtml('Hello there')).toBe(false)
    expect(looksLikeHtml('a < b and b > c')).toBe(false)
  })
})

describe('htmlToText', () => {
  it('converts paragraphs and line breaks to newlines', () => {
    expect(htmlToText('<p>Dear parent,</p><p>Your lesson is<br>tomorrow.</p>')).toBe(
      'Dear parent,\nYour lesson is\ntomorrow.',
    )
  })

  it('drops style/script blocks with their content', () => {
    expect(
      htmlToText('<style>.x{color:red}</style><script>alert(1)</script><p>Hi</p>'),
    ).toBe('Hi')
  })

  it('renders list items as bullets', () => {
    expect(htmlToText('<ul><li>Maths</li><li>Biology</li></ul>')).toBe(
      '• Maths\n• Biology',
    )
  })

  it('decodes named, decimal, and hex entities', () => {
    expect(htmlToText('Fish &amp; chips &pound;5 &#8212; great &#x1F44D;')).toBe(
      'Fish & chips £5 — great 👍',
    )
  })

  it('drops out-of-range numeric entities instead of crashing (RangeError guard)', () => {
    // Code points above U+10FFFF make String.fromCodePoint throw — a malformed
    // or hostile email body must never crash the render. They are dropped.
    expect(() => htmlToText('ok &#x110000; &#9999999; done')).not.toThrow()
    // Entities drop to '' and the resulting space run collapses to one.
    expect(htmlToText('ok &#x110000; &#9999999; done')).toBe('ok done')
  })

  it('never emits markup (XSS-shaped input becomes inert text)', () => {
    const out = htmlToText('<img src=x onerror=alert(1)><a href="javascript:x">click</a>')
    expect(out).toBe('click')
    expect(out).not.toContain('<')
  })

  it('collapses runs of blank lines and trailing whitespace', () => {
    expect(htmlToText('<p>a</p><div></div><div></div><p>b</p>')).toBe('a\n\nb')
  })
})

describe('displayMessageBody', () => {
  it('passes plain text through untouched', () => {
    expect(displayMessageBody('Hello — see you at 3pm')).toBe('Hello — see you at 3pm')
    expect(displayMessageBody(null)).toBeNull()
  })

  it('extracts text from HTML bodies', () => {
    expect(displayMessageBody('<p>Hello</p>')).toBe('Hello')
  })
})
