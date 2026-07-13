import { describe, expect, it } from 'vitest'

import {
  isMfaExemptPath,
  isPrivilegedRole,
  mfaEnrolmentRequired,
  resolveMfaEnforcementMode,
} from './mfa-policy'

describe('resolveMfaEnforcementMode', () => {
  it('defaults to OFF when unset (enforcement paused until the env is editable)', () => {
    expect(resolveMfaEnforcementMode(undefined)).toBe('off')
    expect(resolveMfaEnforcementMode('')).toBe('off')
    expect(resolveMfaEnforcementMode('false')).toBe('off')
    expect(resolveMfaEnforcementMode('yes')).toBe('off') // unrecognised → off
  })

  it("'true' enforces for privileged roles; 'all' for every role", () => {
    expect(resolveMfaEnforcementMode('true')).toBe('privileged')
    expect(resolveMfaEnforcementMode('TRUE')).toBe('privileged')
    expect(resolveMfaEnforcementMode('all')).toBe('all')
    expect(resolveMfaEnforcementMode('ALL')).toBe('all')
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
    for (const pathname of ['/account/setup-2fa', '/account/change-password']) {
      expect(mfaEnrolmentRequired({ ...base, pathname })).toBe(false)
      expect(isMfaExemptPath(pathname)).toBe(true)
    }
    expect(isMfaExemptPath('/contacts')).toBe(false)
  })

  it('NEVER redirects an API/data request (the "<!DOCTYPE is not valid JSON" bug)', () => {
    for (const pathname of [
      '/api/trpc/account.totpSetupStart', // the setup page needs these to enrol
      '/api/auth/session',
      '/api/auth/signout',
      '/api/health',
      '/api/internal/mail-render/abc',
    ]) {
      expect(isMfaExemptPath(pathname)).toBe(true)
      expect(mfaEnrolmentRequired({ ...base, pathname })).toBe(false)
    }
  })
})
