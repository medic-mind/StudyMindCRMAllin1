import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'

import {
  assertStrongPassword,
  generateTemporaryPassword,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from './passwords'

describe('passwords', () => {
  it('hashes and verifies round-trip', async () => {
    const hash = await hashPassword('Hunter2!Hunter2!')
    expect(hash).not.toEqual('Hunter2!Hunter2!')
    expect(await verifyPassword('Hunter2!Hunter2!', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('verify rejects empty inputs without throwing', async () => {
    expect(await verifyPassword('', 'whatever')).toBe(false)
    expect(await verifyPassword('whatever', '')).toBe(false)
  })

  it('generateToken returns 32 bytes of url-safe base64 and is unique', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).not.toEqual(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 bytes -> 43 chars unpadded
    expect(a.length).toBe(43)
  })

  it('hashToken is deterministic sha256 hex', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abc')).not.toBe(hashToken('abcd'))
  })

  describe('assertStrongPassword', () => {
    it('rejects short passwords', () => {
      expect(() => assertStrongPassword('short')).toThrow(BusinessError)
    })
    it('rejects passwords with fewer than 3 character classes', () => {
      expect(() => assertStrongPassword('alllowercaseonly')).toThrow(BusinessError)
      expect(() => assertStrongPassword('ALLLOWERCASEONLY')).toThrow(BusinessError)
    })
    it('accepts a strong password', () => {
      expect(() => assertStrongPassword('GoodPassword123')).not.toThrow()
      expect(() => assertStrongPassword('another-Strong-1')).not.toThrow()
    })
  })

  describe('generateTemporaryPassword', () => {
    it('always produces a value that passes the strength policy', () => {
      for (let i = 0; i < 200; i += 1) {
        const pw = generateTemporaryPassword()
        expect(pw.length).toBe(16)
        expect(() => assertStrongPassword(pw)).not.toThrow()
      }
    })

    it('avoids ambiguous characters and is unique per call', () => {
      const a = generateTemporaryPassword()
      const b = generateTemporaryPassword()
      expect(a).not.toEqual(b)
      expect(a).not.toMatch(/[0O1lI]/)
    })
  })
})
