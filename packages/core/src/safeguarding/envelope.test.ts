// Local-key envelope wrap/unwrap. CLAUDE.md §21.1.
//
// Regression guard for the "won't save / can't decrypt" footgun: previously
// CRM_LOCAL_ENCRYPTION_KEY had to decode to EXACTLY 32 bytes or every wrap and
// unwrap threw. Now any non-empty value works (a real 32-byte key passes
// through; anything else is HKDF-derived to 32 bytes deterministically), so a
// round-trip succeeds and the same env value always recovers the data.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateDataKey, unwrapDataKey } from './envelope'
import { setKmsClient } from './kms'

const ENV_KEYS = ['AWS_KMS_KEY_ID', 'CRM_LOCAL_ENCRYPTION_KEY', 'AUTH_SECRET', 'NEXTAUTH_SECRET']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // Force the local (non-KMS) backend.
  setKmsClient(null)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function roundTrip(): Promise<boolean> {
  const { plaintext, ciphertext } = await generateDataKey()
  const recovered = await unwrapDataKey(ciphertext)
  return recovered.equals(plaintext)
}

describe('local master key (CRM_LOCAL_ENCRYPTION_KEY)', () => {
  it('works with an arbitrary short string (no "must be 32 bytes" throw)', async () => {
    process.env['CRM_LOCAL_ENCRYPTION_KEY'] = 'whatever-the-user-pasted'
    expect(await roundTrip()).toBe(true)
  })

  it('works with a proper 32-byte base64 key (openssl rand -base64 32)', async () => {
    // 32 bytes of base64.
    process.env['CRM_LOCAL_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64')
    expect(await roundTrip()).toBe(true)
  })

  it('the same env value recovers data wrapped earlier (stable across deploys)', async () => {
    process.env['CRM_LOCAL_ENCRYPTION_KEY'] = 'a-fixed-passphrase'
    const { plaintext, ciphertext } = await generateDataKey()
    // Simulate a later deploy: same env value, fresh unwrap.
    const recovered = await unwrapDataKey(ciphertext)
    expect(recovered.equals(plaintext)).toBe(true)
  })

  it('falls back to AUTH_SECRET when no explicit key is set', async () => {
    process.env['AUTH_SECRET'] = 'auth-secret-value'
    expect(await roundTrip()).toBe(true)
  })
})
