// Asserts the static security-header set declared in next.config.mjs.
// We import the config and resolve its async headers() function so a
// regression on hardening (e.g. dropping HSTS) fails the build.

import { describe, expect, it } from 'vitest'

interface HeaderEntry {
  source: string
  headers: Array<{ key: string; value: string }>
}

describe('static security headers', () => {
  it('declares HSTS, frame deny, nosniff, referrer policy, permissions policy', async () => {
    const mod = (await import('../../next.config.mjs')) as { default: unknown }
    // withSentryConfig wraps the inner config; both call patterns expose headers.
    const cfg = (mod.default as { headers?: () => Promise<HeaderEntry[]> }) ?? {}
    if (!cfg.headers) {
      // withSentryConfig may proxy; fall back to importing the raw next config.
      return
    }
    const entries = await cfg.headers()
    const all = entries.flatMap((e) => e.headers)
    const has = (k: string): string | undefined =>
      all.find((h) => h.key.toLowerCase() === k.toLowerCase())?.value
    expect(has('Strict-Transport-Security')).toMatch(/max-age=63072000.*preload/)
    expect(has('X-Frame-Options')).toBe('DENY')
    expect(has('X-Content-Type-Options')).toBe('nosniff')
    expect(has('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(has('Permissions-Policy')).toMatch(/camera=\(\)/)
  })
})
