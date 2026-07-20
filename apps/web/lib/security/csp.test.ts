import { describe, expect, it } from 'vitest'

import { buildCsp, generateNonce } from './csp'

describe('CSP builder', () => {
  it('keeps scripts strict — no unsafe-inline / unsafe-eval on script-src', () => {
    const csp = buildCsp('NONCE')
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src')) ?? ''
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
    // no unsafe-eval anywhere
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it('allows inline styles (sonner + inline-style deps), no style nonce', () => {
    const csp = buildCsp('NONCE')
    const styleSrc = csp.split('; ').find((d) => d.startsWith('style-src')) ?? ''
    expect(styleSrc).toContain("'unsafe-inline'")
    // a nonce would make browsers ignore 'unsafe-inline', so style-src carries none
    expect(styleSrc).not.toContain('nonce-')
  })

  it('embeds the per-request nonce on scripts', () => {
    const csp = buildCsp('ABC123')
    expect(csp).toContain("'nonce-ABC123'")
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src')) ?? ''
    expect(scriptSrc).toContain("'nonce-ABC123'")
  })

  it('denies framing and bare object/embed', () => {
    const csp = buildCsp('n')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
  })

  it('allows same-origin + blob frame-src for the invoice PDF preview', () => {
    expect(buildCsp('n')).toContain("frame-src 'self' blob:")
  })

  it('uses strict-dynamic for script-src', () => {
    expect(buildCsp('n')).toContain("'strict-dynamic'")
  })

  it('allows Sentry hosts and Google for OAuth form-action', () => {
    const csp = buildCsp('n')
    expect(csp).toContain('https://*.sentry.io')
    expect(csp).toContain('https://accounts.google.com')
  })

  it('no longer references Clerk hosts', () => {
    const csp = buildCsp('n')
    expect(csp).not.toContain('clerk.com')
    expect(csp).not.toContain('clerk.accounts.dev')
  })

  it('generateNonce produces unique high-entropy values', () => {
    const a = generateNonce()
    const b = generateNonce()
    expect(a).not.toEqual(b)
    // base64 of 16 random bytes is 24 chars including padding
    expect(a.length).toBeGreaterThanOrEqual(20)
  })
})
