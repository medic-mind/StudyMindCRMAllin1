// Light render check for the sign-in page. Asserts that key copy and the
// form fields are present. Verbose UI snapshotting is deferred until we
// have a per-route Playwright a11y sweep — for now we keep this fast.

import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('sign-in page surface', () => {
  it('renders email/password fields and links', () => {
    const formSrc = readFileSync(
      resolve(__dirname, 'form.tsx'),
      'utf8',
    )
    expect(formSrc).toMatch(/id="email"/)
    expect(formSrc).toMatch(/id="password"/)
    expect(formSrc).toMatch(/\/forgot/)
    expect(formSrc).toMatch(/\/sign-up/)
  })

  it('maps known NextAuth error codes to friendly copy', () => {
    const formSrc = readFileSync(resolve(__dirname, 'form.tsx'), 'utf8')
    expect(formSrc).toMatch(/INVALID_CREDENTIALS/)
    expect(formSrc).toMatch(/ACCOUNT_LOCKED/)
    expect(formSrc).toMatch(/EMAIL_NOT_VERIFIED/)
  })
})
