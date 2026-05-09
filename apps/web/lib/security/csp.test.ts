import { describe, expect, it } from 'vitest'

import { buildCsp, generateNonce } from './csp'

describe('CSP builder', () => {
  it('forbids unsafe-inline', () => {
    const csp = buildCsp('NONCE')
    expect(csp).not.toContain("'unsafe-inline'")
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it('embeds the per-request nonce', () => {
    const csp = buildCsp('ABC123')
    expect(csp).toContain("'nonce-ABC123'")
  })

  it('denies framing and bare object/embed', () => {
    const csp = buildCsp('n')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
  })

  it('uses strict-dynamic for script-src', () => {
    expect(buildCsp('n')).toContain("'strict-dynamic'")
  })

  it('allows Clerk and Sentry hosts', () => {
    const csp = buildCsp('n')
    expect(csp).toContain('https://*.clerk.com')
    expect(csp).toContain('https://*.sentry.io')
  })

  it('generateNonce produces unique high-entropy values', () => {
    const a = generateNonce()
    const b = generateNonce()
    expect(a).not.toEqual(b)
    // base64 of 16 random bytes is 24 chars including padding
    expect(a.length).toBeGreaterThanOrEqual(20)
  })
})
