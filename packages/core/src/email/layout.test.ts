import { describe, expect, it } from 'vitest'

import { emailButton, escapeHtml, renderEmailLayout } from './layout'

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('emailButton', () => {
  it('renders an anchor with the href + label escaped', () => {
    const out = emailButton('https://x/y?a=1&b=2', 'Click <here>')
    expect(out).toContain('href="https://x/y?a=1&amp;b=2"')
    expect(out).toContain('Click &lt;here&gt;')
    expect(out).toContain('display:inline-block')
  })
})

describe('renderEmailLayout', () => {
  it('renders the wordmark when no logo, with heading + body + footer', () => {
    const html = renderEmailLayout({
      brandName: 'StudyMind CRM',
      heading: 'Welcome',
      bodyHtml: '<p>Hi</p>',
      footerNote: 'Why you got this.',
    })
    expect(html).toContain('>StudyMind CRM</div>')
    expect(html).toContain('Welcome')
    expect(html).toContain('<p>Hi</p>')
    expect(html).toContain('Why you got this.')
    expect(html).not.toContain('<img')
  })

  it('renders a logo image when logoUrl is given', () => {
    const html = renderEmailLayout({
      brandName: 'StudyMind',
      heading: 'Hi',
      bodyHtml: '<p>x</p>',
      footerNote: 'note',
      logoUrl: 'https://crm.studymind.co.uk/api/branding/logo',
    })
    expect(html).toContain('<img src="https://crm.studymind.co.uk/api/branding/logo"')
    expect(html).toContain('alt="StudyMind"')
  })

  it('escapes the heading + brand (no injection from dynamic copy)', () => {
    const html = renderEmailLayout({
      brandName: 'A & B',
      heading: '<script>',
      bodyHtml: '<p>safe</p>',
      footerNote: 'n',
    })
    expect(html).toContain('A &amp; B')
    expect(html).toContain('&lt;script&gt;')
    // bodyHtml is trusted (already-built markup) and passes through.
    expect(html).toContain('<p>safe</p>')
  })

  it('includes a hidden preheader (defaults to the heading)', () => {
    const html = renderEmailLayout({
      brandName: 'StudyMind',
      heading: 'Set up your Direct Debit',
      bodyHtml: '<p>x</p>',
      footerNote: 'n',
      preheader: 'Two minutes to get started.',
    })
    expect(html).toContain('Two minutes to get started.')
    expect(html).toMatch(/display:none;max-height:0/)
  })
})
