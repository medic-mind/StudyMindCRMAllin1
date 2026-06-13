// Communications Hub domain — multi-account email (ADR 0021).
//
// Provider-agnostic mail-account types, the provider capability registry, the
// `MailSyncProvider` seam, and pure invariants. No I/O: the tRPC router does
// the DB work and `apps/web/lib/mail/get-sync-provider.ts` dispatches the
// seam to per-provider adapters. CLAUDE.md §14, ADR 0021.

import { z } from 'zod'

export * from './sync-provider'
export * from './conversation-head'
export * from './signature'

// -----------------------------------------------------------------------------
// Enumerations — mirror the Prisma enums one-for-one.
// -----------------------------------------------------------------------------

export const MAIL_PROVIDER_IDS = [
  'gmail',
  'google_workspace',
  'outlook',
  'exchange',
  'imap',
] as const
export const MailProviderId = z.enum(MAIL_PROVIDER_IDS)
export type MailProviderId = z.infer<typeof MailProviderId>

export const MAIL_OWNER_KINDS = ['personal', 'shared'] as const
export const MailAccountOwnerKind = z.enum(MAIL_OWNER_KINDS)
export type MailAccountOwnerKind = z.infer<typeof MailAccountOwnerKind>

export const MAIL_ACCOUNT_STATUSES = [
  'connected',
  'needs_reconnect',
  'disconnected',
  'error',
] as const
export const MailAccountStatus = z.enum(MAIL_ACCOUNT_STATUSES)
export type MailAccountStatus = z.infer<typeof MailAccountStatus>

export const MAIL_MEMBER_ACCESS = ['agent', 'viewer'] as const
export const MailMemberAccess = z.enum(MAIL_MEMBER_ACCESS)
export type MailMemberAccess = z.infer<typeof MailMemberAccess>

// -----------------------------------------------------------------------------
// Provider capability registry.
//
// Pure data. Drives the connect UI and fail-closed behaviour (§8): only
// providers with `connectable: true` can be wired today; the rest advertise the
// roadmap (ADR 0021) and a connection attempt is rejected. `capabilities`
// describes the *target* feature set per provider and is used for UI hints and
// future per-capability gating.
// -----------------------------------------------------------------------------

export type MailAuthKind = 'oauth_google' | 'oauth_microsoft' | 'basic_imap'

export interface MailProviderCapabilities {
  /** Send mail (SMTP / API). */
  send: boolean
  /** Read / sync mail. */
  read: boolean
  /** Real-time push (Gmail watch, Graph change notifications). */
  push: boolean
  /** Gmail-style labels. */
  labels: boolean
  /** IMAP / Outlook-style folders. */
  folders: boolean
  /** Native conversation threading. */
  threads: boolean
  /** Mutate flags/labels/folders back to the provider (read, archive, …). */
  twoWaySync: boolean
}

export interface MailProviderInfo {
  id: MailProviderId
  label: string
  authKind: MailAuthKind
  /** True when the CRM can connect this provider today. */
  connectable: boolean
  /** One-line note shown in the UI (e.g. why a provider is not yet live). */
  note: string
  capabilities: MailProviderCapabilities
}

const GOOGLE_CAPS: MailProviderCapabilities = {
  send: true,
  read: true,
  push: true,
  labels: true,
  folders: false,
  threads: true,
  twoWaySync: true,
}

const MICROSOFT_CAPS: MailProviderCapabilities = {
  send: true,
  read: true,
  push: true,
  labels: false,
  folders: true,
  threads: true,
  twoWaySync: true,
}

const IMAP_CAPS: MailProviderCapabilities = {
  send: true,
  read: true,
  push: false,
  labels: false,
  folders: true,
  threads: false,
  twoWaySync: true,
}

export const MAIL_PROVIDERS: Record<MailProviderId, MailProviderInfo> = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    authKind: 'oauth_google',
    connectable: true,
    note: 'Connected via Google OAuth — live two-way sync (ADR 0012).',
    capabilities: GOOGLE_CAPS,
  },
  google_workspace: {
    id: 'google_workspace',
    label: 'Google Workspace',
    authKind: 'oauth_google',
    connectable: false,
    note: 'Same Google OAuth as Gmail — enabled in a fast follow.',
    capabilities: GOOGLE_CAPS,
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook 365',
    authKind: 'oauth_microsoft',
    connectable: false,
    note: 'Microsoft Graph provider — roadmap (ADR 0021 Phase 7).',
    capabilities: MICROSOFT_CAPS,
  },
  exchange: {
    id: 'exchange',
    label: 'Microsoft Exchange',
    authKind: 'oauth_microsoft',
    connectable: false,
    note: 'Exchange provider — roadmap (ADR 0021 Phase 7).',
    capabilities: { ...MICROSOFT_CAPS, push: false },
  },
  imap: {
    id: 'imap',
    label: 'IMAP / SMTP',
    authKind: 'basic_imap',
    connectable: false,
    note: 'Generic IMAP/SMTP provider — roadmap (ADR 0021 Phase 7).',
    capabilities: IMAP_CAPS,
  },
}

export function getMailProvider(id: MailProviderId): MailProviderInfo {
  return MAIL_PROVIDERS[id]
}

export function mailProviderLabel(id: MailProviderId): string {
  return MAIL_PROVIDERS[id]?.label ?? id
}

export function isConnectableProvider(id: MailProviderId): boolean {
  return MAIL_PROVIDERS[id]?.connectable ?? false
}

export function listMailProviders(): MailProviderInfo[] {
  return MAIL_PROVIDER_IDS.map((id) => MAIL_PROVIDERS[id])
}

// -----------------------------------------------------------------------------
// Normalisation.
// -----------------------------------------------------------------------------

/** Canonical form for an email address used as the unique account key. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

// -----------------------------------------------------------------------------
// View-model (router output).
// -----------------------------------------------------------------------------

export const MailAccountView = z.object({
  id: z.string(),
  provider: MailProviderId,
  providerLabel: z.string(),
  connectable: z.boolean(),
  address: z.string(),
  displayName: z.string().nullable(),
  ownerKind: MailAccountOwnerKind,
  ownerUserId: z.string().nullable(),
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  status: MailAccountStatus,
  isDefault: z.boolean(),
  gmailMailboxId: z.string().nullable(),
  memberCount: z.number().int(),
  watchExpiresAt: z.date().nullable(),
  lastSyncedAt: z.date().nullable(),
  createdAt: z.date(),
})
export type MailAccountView = z.infer<typeof MailAccountView>

// -----------------------------------------------------------------------------
// Input schemas — shared by the router and the React Hook Form (§27).
// -----------------------------------------------------------------------------

export const CreateSharedMailAccountInput = z.object({
  provider: MailProviderId,
  address: z.string().trim().email(),
  displayName: z.string().trim().max(120).optional(),
  teamId: z.string().optional(),
})
export type CreateSharedMailAccountInput = z.infer<
  typeof CreateSharedMailAccountInput
>

export const UpdateMailAccountInput = z.object({
  id: z.string(),
  displayName: z.string().trim().max(120).nullish(),
  status: MailAccountStatus.optional(),
  teamId: z.string().nullish(),
  ownerKind: MailAccountOwnerKind.optional(),
})
export type UpdateMailAccountInput = z.infer<typeof UpdateMailAccountInput>

export const MailAccountMemberInput = z.object({
  mailAccountId: z.string(),
  userId: z.string(),
  access: MailMemberAccess.default('agent'),
})
export type MailAccountMemberInput = z.infer<typeof MailAccountMemberInput>

export const MailAccountIdInput = z.object({ id: z.string() })
export type MailAccountIdInput = z.infer<typeof MailAccountIdInput>

// -----------------------------------------------------------------------------
// Invariants (pure) — property-tested in index.test.ts. CLAUDE.md §41.
// -----------------------------------------------------------------------------

export interface MailAccountShape {
  ownerKind: MailAccountOwnerKind
  ownerUserId: string | null
  address: string
  isDefault: boolean
  provider: MailProviderId
}

/**
 * Returns the list of invariant violations for a single account. Empty array
 * means the row is well-formed.
 */
export function mailAccountInvariantViolations(a: MailAccountShape): string[] {
  const violations: string[] = []
  if (a.ownerKind === 'personal' && !a.ownerUserId) {
    violations.push('personal_account_requires_owner')
  }
  if (a.isDefault && a.ownerKind !== 'personal') {
    violations.push('default_must_be_personal')
  }
  if (a.address.trim() === '') {
    violations.push('address_required')
  }
  if (a.address !== normaliseEmail(a.address)) {
    violations.push('address_must_be_normalised')
  }
  if (!(MAIL_PROVIDER_IDS as readonly string[]).includes(a.provider)) {
    violations.push('unknown_provider')
  }
  return violations
}

export function isValidMailAccount(a: MailAccountShape): boolean {
  return mailAccountInvariantViolations(a).length === 0
}

/**
 * Cross-row invariant: a user has at most one default *personal* account.
 * Returns true if the set violates it (used by tests; the router enforces it
 * by clearing other defaults in a transaction on setDefault).
 */
export function violatesSingleDefault(
  accounts: ReadonlyArray<{ ownerUserId: string | null; isDefault: boolean }>,
): boolean {
  const counts = new Map<string, number>()
  for (const a of accounts) {
    if (!a.isDefault || !a.ownerUserId) continue
    counts.set(a.ownerUserId, (counts.get(a.ownerUserId) ?? 0) + 1)
  }
  for (const n of counts.values()) {
    if (n > 1) return true
  }
  return false
}
