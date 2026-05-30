// Communications Hub domain tests (ADR 0021). Pure unit + property-based
// coverage of the provider registry and the mail-account invariants.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  CreateSharedMailAccountInput,
  MAIL_PROVIDER_IDS,
  MAIL_PROVIDERS,
  MailAccountMemberInput,
  type MailAccountShape,
  getMailProvider,
  isConnectableProvider,
  isValidMailAccount,
  listMailProviders,
  mailAccountInvariantViolations,
  mailProviderLabel,
  normaliseEmail,
  violatesSingleDefault,
} from './index'

describe('provider registry', () => {
  it('has an entry for every provider id, keyed consistently', () => {
    for (const id of MAIL_PROVIDER_IDS) {
      const info = MAIL_PROVIDERS[id]
      expect(info).toBeDefined()
      expect(info.id).toBe(id)
      expect(info.label.length).toBeGreaterThan(0)
      expect(info.note.length).toBeGreaterThan(0)
    }
    expect(listMailProviders()).toHaveLength(MAIL_PROVIDER_IDS.length)
  })

  it('only gmail is connectable today (fails closed on the rest)', () => {
    expect(isConnectableProvider('gmail')).toBe(true)
    expect(isConnectableProvider('google_workspace')).toBe(false)
    expect(isConnectableProvider('outlook')).toBe(false)
    expect(isConnectableProvider('exchange')).toBe(false)
    expect(isConnectableProvider('imap')).toBe(false)
  })

  it('connectable providers can both send and read', () => {
    for (const info of listMailProviders()) {
      if (!info.connectable) continue
      expect(info.capabilities.send).toBe(true)
      expect(info.capabilities.read).toBe(true)
    }
  })

  it('labels a provider, falling back to the id', () => {
    expect(mailProviderLabel('gmail')).toBe('Gmail')
    expect(getMailProvider('outlook').authKind).toBe('oauth_microsoft')
  })
})

describe('normaliseEmail', () => {
  it('lowercases and trims, and is idempotent', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.constantFrom('', ' ', '  ', '\t'),
        (email, pad) => {
          const messy = `${pad}${email.toUpperCase()}${pad}`
          const once = normaliseEmail(messy)
          expect(once).toBe(email.toLowerCase())
          // Idempotent: normalising again is a no-op.
          expect(normaliseEmail(once)).toBe(once)
        },
      ),
    )
  })
})

describe('mailAccountInvariantViolations', () => {
  const base: MailAccountShape = {
    ownerKind: 'personal',
    ownerUserId: 'u_1',
    address: 'agent@studymind.co.uk',
    isDefault: true,
    provider: 'gmail',
  }

  it('accepts a well-formed personal account', () => {
    expect(mailAccountInvariantViolations(base)).toEqual([])
    expect(isValidMailAccount(base)).toBe(true)
  })

  it('accepts a well-formed shared account (no owner, not default)', () => {
    expect(
      mailAccountInvariantViolations({
        ...base,
        ownerKind: 'shared',
        ownerUserId: null,
        isDefault: false,
      }),
    ).toEqual([])
  })

  it('flags a personal account with no owner', () => {
    expect(
      mailAccountInvariantViolations({ ...base, ownerUserId: null }),
    ).toContain('personal_account_requires_owner')
  })

  it('flags a default that is not personal', () => {
    expect(
      mailAccountInvariantViolations({
        ...base,
        ownerKind: 'shared',
        ownerUserId: null,
        isDefault: true,
      }),
    ).toContain('default_must_be_personal')
  })

  it('flags an un-normalised or empty address', () => {
    expect(
      mailAccountInvariantViolations({ ...base, address: 'AGENT@studymind.co.uk' }),
    ).toContain('address_must_be_normalised')
    expect(
      mailAccountInvariantViolations({ ...base, address: '   ' }),
    ).toContain('address_required')
  })

  it('property: a normalised personal account with an owner is always valid', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.constantFrom(...MAIL_PROVIDER_IDS),
        (email, ownerId, provider) => {
          const account: MailAccountShape = {
            ownerKind: 'personal',
            ownerUserId: ownerId,
            address: normaliseEmail(email),
            isDefault: true,
            provider,
          }
          expect(isValidMailAccount(account)).toBe(true)
        },
      ),
    )
  })
})

describe('violatesSingleDefault', () => {
  it('false when each owner has at most one default', () => {
    expect(
      violatesSingleDefault([
        { ownerUserId: 'u_1', isDefault: true },
        { ownerUserId: 'u_1', isDefault: false },
        { ownerUserId: 'u_2', isDefault: true },
        { ownerUserId: null, isDefault: true },
      ]),
    ).toBe(false)
  })

  it('true when one owner has two defaults', () => {
    expect(
      violatesSingleDefault([
        { ownerUserId: 'u_1', isDefault: true },
        { ownerUserId: 'u_1', isDefault: true },
      ]),
    ).toBe(true)
  })

  it('property: at most one default per owner never violates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 20 }),
        (owners) => {
          // Give each owner exactly one default account plus extra non-defaults.
          const unique = Array.from(new Set(owners))
          const accounts = [
            ...unique.map((ownerUserId) => ({ ownerUserId, isDefault: true })),
            ...unique.map((ownerUserId) => ({ ownerUserId, isDefault: false })),
          ]
          expect(violatesSingleDefault(accounts)).toBe(false)
        },
      ),
    )
  })
})

describe('input schemas', () => {
  it('rejects a malformed shared-account email', () => {
    expect(
      CreateSharedMailAccountInput.safeParse({
        provider: 'gmail',
        address: 'not-an-email',
      }).success,
    ).toBe(false)
  })

  it('accepts a valid shared-account payload', () => {
    const parsed = CreateSharedMailAccountInput.safeParse({
      provider: 'gmail',
      address: 'admissions@studymind.co.uk',
      displayName: 'Admissions',
    })
    expect(parsed.success).toBe(true)
  })

  it('defaults member access to agent', () => {
    const parsed = MailAccountMemberInput.parse({
      mailAccountId: 'm_1',
      userId: 'u_1',
    })
    expect(parsed.access).toBe('agent')
  })
})
