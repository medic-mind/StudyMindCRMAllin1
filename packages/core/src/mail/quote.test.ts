import { describe, expect, it } from 'vitest'

import {
  buildForwardQuote,
  buildReplyQuote,
  computeReplyAllRecipients,
  computeReplyRecipients,
  forwardSubject,
  replySubject,
} from './quote'

describe('computeReplyAllRecipients', () => {
  it('replies to the sender and Ccs everyone else, excluding us', () => {
    const r = computeReplyAllRecipients({
      from: ['jane@x.com'],
      to: ['me@studymind.co.uk', 'bob@y.com'],
      cc: ['carol@z.com', 'JANE@x.com'],
      self: ['me@studymind.co.uk'],
    })
    expect(r.to).toEqual(['jane@x.com'])
    // bob + carol; not us, not the sender (jane), de-duped case-insensitively
    expect(r.cc).toEqual(['bob@y.com', 'carol@z.com'])
  })

  it('returns empty when there is no sender', () => {
    expect(computeReplyAllRecipients({ from: [], to: [], cc: [], self: [] })).toEqual({
      to: [],
      cc: [],
    })
  })
})

describe('computeReplyRecipients', () => {
  it('replies to the sender only', () => {
    expect(
      computeReplyRecipients({ from: ['jane@x.com'], self: ['me@studymind.co.uk'] }).to,
    ).toEqual(['jane@x.com'])
  })
})

describe('subjects', () => {
  it('prefixes Re: once and strips Fwd:', () => {
    expect(replySubject('Hello')).toBe('Re: Hello')
    expect(replySubject('Re: Hello')).toBe('Re: Hello')
    expect(replySubject('Fwd: Hello')).toBe('Re: Hello')
    expect(replySubject(null)).toBe('Re:')
  })
  it('prefixes Fwd: once and strips Re:', () => {
    expect(forwardSubject('Hello')).toBe('Fwd: Hello')
    expect(forwardSubject('Fwd: Hello')).toBe('Fwd: Hello')
    expect(forwardSubject('Re: Hello')).toBe('Fwd: Hello')
  })
})

describe('buildReplyQuote', () => {
  it('builds an attribution + quoted text and an html blockquote', () => {
    const q = buildReplyQuote({
      date: new Date('2026-06-10T13:30:00Z'),
      fromName: 'Jane Doe',
      fromEmail: 'jane@x.com',
      text: 'Original line 1\nline 2',
      html: '<p>Original</p>',
    })
    expect(q.text).toContain('Jane Doe <jane@x.com> wrote:')
    expect(q.text).toContain('> Original line 1')
    expect(q.text).toContain('> line 2')
    expect(q.html).toContain('blockquote')
    expect(q.html).toContain('<p>Original</p>')
  })

  it('falls back to escaped text when no html is present', () => {
    const q = buildReplyQuote({
      date: null,
      fromName: null,
      fromEmail: 'jane@x.com',
      text: '<script>alert(1)</script>',
      html: null,
    })
    expect(q.html).toContain('&lt;script&gt;')
    expect(q.html).not.toContain('<script>')
  })
})

describe('buildForwardQuote', () => {
  it('includes the forwarded-message header block', () => {
    const q = buildForwardQuote({
      date: new Date('2026-06-10T13:30:00Z'),
      fromName: 'Jane Doe',
      fromEmail: 'jane@x.com',
      to: ['me@studymind.co.uk'],
      cc: [],
      subject: 'Quote request',
      text: 'Please send pricing.',
      html: null,
    })
    expect(q.text).toContain('---------- Forwarded message ----------')
    expect(q.text).toContain('From: Jane Doe <jane@x.com>')
    expect(q.text).toContain('Subject: Quote request')
    expect(q.text).toContain('Please send pricing.')
    expect(q.html).toContain('Forwarded message')
  })
})
