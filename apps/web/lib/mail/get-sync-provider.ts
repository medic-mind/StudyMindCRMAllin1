// Runtime dispatcher for the MailSyncProvider seam (ADR 0021 Phase 2).
//
// Given a `MailAccount.id`, return the right per-provider implementation. The
// account row owns the provider type and (for gmail) the bridge to the legacy
// `GmailMailbox`; the seam owners stay providers, and the dispatcher stays
// boring — one switch on `provider`. The factory functions are statically
// imported so the bundler can tree-shake; we never load all SDKs eagerly.

import { TRPCError } from '@trpc/server'

import { db } from '@studymind/db'
import {
  MailProviderUnavailableError,
  isConnectableProvider,
  type MailSyncProvider,
} from '@studymind/core/mail'
import { createGmailMailSyncProvider } from '@studymind/integration-gmail/mail-provider'

export interface GetSyncProviderInput {
  /** MailAccount.id to resolve. */
  accountId: string
  /** Audit/correlation context forwarded to provider-side decryption calls. */
  requestId?: string
  /** Purpose passed to KMS decrypt (CLAUDE.md §21). */
  purpose?: string
}

/**
 * Resolve a `MailSyncProvider` for the given MailAccount. Throws when the
 * account is missing, disconnected, soft-deleted, or sits on a provider that
 * is not yet connectable (§8 fails closed).
 */
export async function getMailSyncProvider(
  input: GetSyncProviderInput,
): Promise<MailSyncProvider> {
  const account = await db.mailAccount.findFirst({
    where: { id: input.accountId, deletedAt: null },
    select: {
      id: true,
      provider: true,
      ownerUserId: true,
      status: true,
      address: true,
    },
  })
  if (!account) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Mail account not found' })
  }
  if (!isConnectableProvider(account.provider)) {
    throw new MailProviderUnavailableError(account.provider)
  }
  if (account.status === 'disconnected') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Mail account is disconnected — reconnect it first.',
    })
  }
  if (!account.ownerUserId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Mail account has no owner (cannot resolve credentials).',
    })
  }

  switch (account.provider) {
    case 'gmail':
      return createGmailMailSyncProvider({
        accountId: account.id,
        agentId: account.ownerUserId,
        ...(account.address ? { address: account.address } : {}),
        clientOptions: {
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
      })
    // Workspace / Outlook / Exchange / IMAP land in later phases (ADR 0021).
    case 'google_workspace':
    case 'outlook':
    case 'exchange':
    case 'imap':
      throw new MailProviderUnavailableError(account.provider)
  }
}
