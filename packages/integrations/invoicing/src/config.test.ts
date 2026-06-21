// Config status loader test. The regression this guards: the Settings page
// status badge must NOT decrypt the stored secrets — a KMS/local-key failure
// (or any decrypt throw) must never 500 the page. So loadInvoicingConfigStatus
// reads presence + the plaintext last-4 only, and never calls decryptField.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique, decryptField, warn } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  decryptField: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@studymind/db', () => ({
  db: { invoicingSetting: { findUnique } },
}))

vi.mock('@studymind/core/safeguarding', () => ({
  decryptField: decryptField,
  // generateDataKey / KEY_VERSION are only used on the write path; stub so the
  // module imports cleanly.
  generateDataKey: vi.fn(),
  KEY_VERSION: 1,
}))

vi.mock('@studymind/core/logger', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { loadInvoicingConfig, loadInvoicingConfigStatus } from './config'

/** A persisted row with both secrets present (non-null envelope columns), so
 *  loadInvoicingConfig proceeds to call decryptField for each. */
function rowWithSecrets() {
  return {
    baseUrl: 'https://b2b.studymind.co.uk',
    apiKeyCiphertext: Buffer.from('ct'),
    apiKeyIv: Buffer.from('iv'),
    apiKeyDekCiphertext: Buffer.from('dek'),
    apiKeyAad: Buffer.from('aad'),
    apiKeyKeyVersion: 1,
    apiKeyLast4: 'aB12',
    webhookSecretCiphertext: null,
    webhookSecretIv: null,
    webhookSecretDekCiphertext: null,
    webhookSecretAad: null,
    webhookSecretKeyVersion: null,
    eventsCursor: '42',
    streamCursor: '7',
  }
}

const ENV_KEYS = ['INVOICING_API_KEY', 'INVOICING_WEBHOOK_SECRET', 'INVOICING_API_BASE_URL']
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('loadInvoicingConfigStatus', () => {
  it('reports configured from ciphertext presence WITHOUT decrypting', async () => {
    findUnique.mockResolvedValue({
      baseUrl: 'https://b2b.studymind.co.uk',
      apiKeyCiphertext: Buffer.from('ciphertext'),
      apiKeyLast4: 'aB12',
      webhookSecretCiphertext: Buffer.from('ciphertext'),
      eventsCursor: '42',
      streamCursor: '7',
    })

    const status = await loadInvoicingConfigStatus()

    expect(status.configured).toBe(true)
    expect(status.webhookSecretConfigured).toBe(true)
    expect(status.apiKeyLast4).toBe('aB12')
    expect(status.eventsCursor).toBe('42')
    expect(status.streamCursor).toBe('7')
    // The whole point: rendering the badge never touches decryption.
    expect(decryptField).not.toHaveBeenCalled()
  })

  it('reports not-configured when no row and no env', async () => {
    findUnique.mockResolvedValue(null)

    const status = await loadInvoicingConfigStatus()

    expect(status.configured).toBe(false)
    expect(status.webhookSecretConfigured).toBe(false)
    expect(status.apiKeyLast4).toBeNull()
    expect(status.baseUrl).toBe('https://b2b.studymind.co.uk')
    expect(decryptField).not.toHaveBeenCalled()
  })

  it('falls back to env vars when the DB row is absent', async () => {
    findUnique.mockResolvedValue(null)
    process.env['INVOICING_API_KEY'] = 'sk_live_envkey9999'
    process.env['INVOICING_WEBHOOK_SECRET'] = 'whsec_env'

    const status = await loadInvoicingConfigStatus()

    expect(status.configured).toBe(true)
    expect(status.webhookSecretConfigured).toBe(true)
    expect(status.apiKeyLast4).toBe('9999')
    expect(decryptField).not.toHaveBeenCalled()
  })
})

describe('loadInvoicingConfig (secret decryption + env fallback)', () => {
  it('returns the decrypted API key when decryption succeeds', async () => {
    findUnique.mockResolvedValue(rowWithSecrets())
    decryptField.mockResolvedValue('sk_live_decrypted123')

    const cfg = await loadInvoicingConfig()

    expect(cfg.apiKey).toBe('sk_live_decrypted123')
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to INVOICING_API_KEY when the stored key cannot be decrypted', async () => {
    // The regression: a master-key change makes decryptField throw 'failed to
    // unwrap data key'. That must degrade to the env var, not brick every
    // outbound write + the inbound sync.
    findUnique.mockResolvedValue(rowWithSecrets())
    decryptField.mockRejectedValue(new Error('failed to unwrap data key'))
    process.env['INVOICING_API_KEY'] = 'sk_live_envfallback'

    const cfg = await loadInvoicingConfig()

    expect(cfg.apiKey).toBe('sk_live_envfallback')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('re-throws the decrypt error when there is no env fallback', async () => {
    // No INVOICING_API_KEY (beforeEach clears it) → surface the actionable
    // error so the caller tells the user to re-save the key, rather than
    // silently going dark.
    findUnique.mockResolvedValue(rowWithSecrets())
    decryptField.mockRejectedValue(new Error('failed to unwrap data key'))

    await expect(loadInvoicingConfig()).rejects.toThrow(/unwrap data key/)
    expect(warn).not.toHaveBeenCalled()
  })
})
