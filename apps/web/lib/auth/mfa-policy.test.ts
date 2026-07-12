import { describe, expect, it } from 'vitest'

import {
  isMfaExemptPath,
  isPrivilegedRole,
  mfaEnrolmentRequired,
  resolveMfaEnforcementMode,
} from './mfa-policy'

describe('resolveMfaEnforcementMode', () => {
  it('defaults to privileged enforcement when unset (the §20 spec)', () => {
    expect(resolveMfaEnforcementMode(undefined)).toBe('privileged')
    expect(resolveMfaEnforcementMode('')).toBe('privileged')
    expect(resolveMfaEnforcementMode('true')).toBe('privileged')
  })

  it("'all' extends enforcement to every role; 'false' is the explicit opt-out", () => {
    expect(resolveMfaEnforcementMode('all')).toBe('all')
    expect(resolveMfaEnforcementMode('ALL')).toBe('all')
    expect(resolveMfaEnforcementMode('false')).toBe('off')
    expect(resolveMfaEnforcementMode('False')).toBe('off')
  })

  it('an unrecognised value fails closed to the spec default, not to off', () => {
    expect(resolveMfaEnforcementMode('yes')).toBe('privileged')
  })
})

describe('isPrivilegedRole', () => {
  it('matches canonical privileged roles and legacy aliases', () => {
    expect(isPrivilegedRole(['ceo'], undefined)).toBe(true)
    expect(isPrivilegedRole(undefined, 'senior_manager')).toBe(true)
    expect(isPrivilegedRole(['manager'], undefined)).toBe(true)
    expect(isPrivilegedRole(['finance'], undefined)).toBe(true) // legacy
    expect(isPrivilegedRole(['sales_executive'], 'sales_executive')).toBe(false)
    expect(isPrivilegedRole(['virtual_assistant'], undefined)).toBe(false)
  })
})

describe('mfaEnrolmentRequired', () => {
  const base = {
    mode: 'privileged' as const,
    roles: ['ceo'],
    role: 'ceo',
    totpEnabled: false,
    pathname: '/contacts',
  }

  it('redirects an unenrolled privileged user by default', () => {
    expect(mfaEnrolmentRequired(base)).toBe(true)
  })

  it('never fires once TOTP is enrolled', () => {
    expect(mfaEnrolmentRequired({ ...base, totpEnabled: true })).toBe(false)
  })

  it('leaves non-privileged roles alone in privileged mode', () => {
    expect(
      mfaEnrolmentRequired({ ...base, roles: ['sales_executive'], role: 'sales_executive' }),
    ).toBe(false)
  })

  it("mode 'all' covers every role; mode 'off' covers nobody", () => {
    expect(
      mfaEnrolmentRequired({
        ...base,
        mode: 'all',
        roles: ['virtual_assistant'],
        role: 'virtual_assistant',
      }),
    ).toBe(true)
    expect(mfaEnrolmentRequired({ ...base, mode: 'off' })).toBe(false)
  })

  it('exempts the pages an unenrolled user must still reach', () => {
    for (const pathname of [
      '/account/setup-2fa',
      '/account/change-password',
      '/api/auth/signout',
      '/api/auth/session',
      '/api/health',
    ]) {
      expect(mfaEnrolmentRequired({ ...base, pathname })).toBe(false)
      expect(isMfaExemptPath(pathname)).toBe(true)
    }
    expect(isMfaExemptPath('/contacts')).toBe(false)
  })
})
