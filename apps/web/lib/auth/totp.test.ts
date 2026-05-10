// Unit tests for the TOTP helper module. We exercise the round-trip,
// recovery-code single-use, and TOTP-vs-recovery disambiguation. The
// authenticator is real — we just freeze time around it where needed.

import { describe, expect, it, vi } from 'vitest'
import { authenticator } from 'otplib'

import {
  TOTP_TEST_HELPERS,
  buildRecoveryCodeRows,
  generateRecoveryCodes,
  generateTotpSecret,
  isRecoveryCodeShaped,
  verifyRecoveryCode,
  verifyTotpCode,
} from './totp'

describe('generateTotpSecret', () => {
  it('returns a base32 secret and a working otpauth URL', () => {
    const s = generateTotpSecret()
    expect(s.base32).toMatch(/^[A-Z2-7]+$/)
    const url = s.otpauthUrl('agent@dev.studymind', 'StudyMind CRM')
    expect(url).toContain('otpauth://totp/')
    expect(url).toContain('agent%40dev.studymind')
    expect(url).toContain(`secret=${s.base32}`)
  })
})

describe('verifyTotpCode', () => {
  it('accepts a freshly generated code', () => {
    const { base32 } = generateTotpSecret()
    const code = authenticator.generate(base32)
    expect(verifyTotpCode({ secret: base32, code })).toBe(true)
  })

  it('rejects malformed codes (not 6 digits)', () => {
    const { base32 } = generateTotpSecret()
    expect(verifyTotpCode({ secret: base32, code: '12345' })).toBe(false)
    expect(verifyTotpCode({ secret: base32, code: '1234567' })).toBe(false)
    expect(verifyTotpCode({ secret: base32, code: 'abcdef' })).toBe(false)
    expect(verifyTotpCode({ secret: base32, code: '' })).toBe(false)
  })

  it('rejects a code generated more than one step in the past', () => {
    const { base32 } = generateTotpSecret()
    const now = Date.now()
    // Generate a code 2 steps (60 s) ago — outside the 1-step window.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(now - 60 * 1000)
      const oldCode = authenticator.generate(base32)
      vi.setSystemTime(now)
      expect(verifyTotpCode({ secret: base32, code: oldCode })).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a code from one step earlier (skew tolerance)', () => {
    const { base32 } = generateTotpSecret()
    const now = Date.now()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(now - 30 * 1000)
      const previousCode = authenticator.generate(base32)
      vi.setSystemTime(now)
      expect(verifyTotpCode({ secret: base32, code: previousCode })).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('recovery codes', () => {
  it('generates 10 codes of 10 chars from the safe alphabet', () => {
    const { plain, hashes } = generateRecoveryCodes()
    expect(plain).toHaveLength(10)
    expect(hashes).toHaveLength(10)
    for (const code of plain) {
      expect(code).toHaveLength(10)
      expect(/^[A-HJ-NP-Z2-9]+$/.test(code)).toBe(true)
    }
    // All distinct.
    expect(new Set(plain).size).toBe(10)
    expect(new Set(hashes).size).toBe(10)
    // Hashes match.
    for (let i = 0; i < 10; i += 1) {
      expect(hashes[i]).toBe(TOTP_TEST_HELPERS.hashRecoveryCode(plain[i]!))
    }
  })

  it('isRecoveryCodeShaped distinguishes from 6-digit TOTP codes', () => {
    expect(isRecoveryCodeShaped('ABCDEFGHJK')).toBe(true)
    expect(isRecoveryCodeShaped('abcdefghjk')).toBe(true) // case-insensitive
    expect(isRecoveryCodeShaped('ABCDE-FGHJK')).toBe(true) // hyphens stripped
    expect(isRecoveryCodeShaped('123456')).toBe(false)
    expect(isRecoveryCodeShaped('SHORT')).toBe(false)
    // Recovery alphabet excludes 0/O/1/I/L — strings using them are rejected.
    expect(isRecoveryCodeShaped('AAAAA0AAAA')).toBe(false)
  })

  it('verifyRecoveryCode marks the matching row used and returns true once', async () => {
    const { plain, hashes } = generateRecoveryCodes()
    const userId = 'u_1'
    const rows = buildRecoveryCodeRows(userId, hashes)

    type Row = (typeof rows)[number] & { usedAt: Date | null }
    const store: Row[] = rows.map((r) => ({ ...r, usedAt: null }))

    const fakeDb = {
      totpRecoveryCode: {
        updateMany: vi.fn(
          async (args: {
            where: { userId: string; codeHash: string; usedAt: null }
            data: { usedAt: Date }
          }) => {
            const match = store.find(
              (r) =>
                r.userId === args.where.userId &&
                r.codeHash === args.where.codeHash &&
                r.usedAt === null,
            )
            if (!match) return { count: 0 }
            match.usedAt = args.data.usedAt
            return { count: 1 }
          },
        ),
      },
    }

    const code = plain[0]!
    expect(
      await verifyRecoveryCode({
        db: fakeDb as never,
        userId,
        code,
      }),
    ).toBe(true)
    // Replay returns false — the row is now marked used.
    expect(
      await verifyRecoveryCode({
        db: fakeDb as never,
        userId,
        code,
      }),
    ).toBe(false)
  })

  it('verifyRecoveryCode rejects strings that are not recovery-shaped without DB call', async () => {
    const fakeDb = {
      totpRecoveryCode: { updateMany: vi.fn(async () => ({ count: 1 })) },
    }
    expect(
      await verifyRecoveryCode({
        db: fakeDb as never,
        userId: 'u_1',
        code: '123456',
      }),
    ).toBe(false)
    expect(fakeDb.totpRecoveryCode.updateMany).not.toHaveBeenCalled()
  })

  it('verifyRecoveryCode rejects unknown codes', async () => {
    const fakeDb = {
      totpRecoveryCode: { updateMany: vi.fn(async () => ({ count: 0 })) },
    }
    expect(
      await verifyRecoveryCode({
        db: fakeDb as never,
        userId: 'u_1',
        code: 'AAAAAAAAAA',
      }),
    ).toBe(false)
  })
})
