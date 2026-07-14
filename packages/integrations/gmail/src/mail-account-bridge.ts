// GmailMailbox → MailAccount bridge (ADR 0021 Phase 1/3).
//
// `processMessage` and the heal sweep attribute email Conversation heads to a
// `MailAccount` resolved through `MailAccount.gmailMailboxId`. Historically the
// bridge row was only created by the explicit Settings → "Import from Gmail"
// action, so a freshly connected mailbox produced heads with
// `mailAccountId = null` — rows the label-mirror heal skipped forever and the
// /mail account rail could not show. This helper materialises the bridge
// idempotently and is called from BOTH the OAuth connect callback and the
// recurring sync sweep, so the invariant "every live GmailMailbox has a
// MailAccount" holds without any manual step.
//
// Deliberately minimal (no signature sync — that stays in the richer
// `mailAccount.syncFromGmail` action): create/repair only what attribution
// needs.

import { createId } from '@paralleldrive/cuid2'

import { db } from '@studymind/db'

interface BridgeableMailbox {
  id: string
  agentId: string
  address: string
  isDefault?: boolean
  watchExpiresAt?: Date | null
}

/**
 * Ensure a personal `MailAccount` row bridges the given GmailMailbox.
 * Idempotent: an existing bridge is left alone (bar undeleting), an existing
 * account with the same address is linked, otherwise a new row is created.
 * Returns the MailAccount id.
 */
export async function ensureMailAccountBridge(
  mailbox: BridgeableMailbox,
): Promise<string> {
  const address = mailbox.address.trim().toLowerCase()

  const byBridge = await db.mailAccount.findUnique({
    where: { gmailMailboxId: mailbox.id },
    select: { id: true, deletedAt: true },
  })
  if (byBridge) {
    if (byBridge.deletedAt) {
      await db.mailAccount.update({
        where: { id: byBridge.id },
        data: { deletedAt: null, status: 'connected' },
      })
    }
    return byBridge.id
  }

  const byAddress = await db.mailAccount.findUnique({
    where: { address },
    select: { id: true },
  })
  if (byAddress) {
    await db.mailAccount.update({
      where: { id: byAddress.id },
      data: {
        gmailMailboxId: mailbox.id,
        provider: 'gmail',
        status: 'connected',
        deletedAt: null,
      },
    })
    return byAddress.id
  }

  const created = await db.mailAccount.create({
    data: {
      id: createId(),
      gmailMailboxId: mailbox.id,
      provider: 'gmail',
      ownerKind: 'personal',
      ownerUserId: mailbox.agentId,
      address,
      status: 'connected',
      isDefault: mailbox.isDefault ?? false,
      watchExpiresAt: mailbox.watchExpiresAt ?? null,
      createdById: mailbox.agentId,
      updatedById: mailbox.agentId,
    },
    select: { id: true },
  })
  return created.id
}

/** Bridge every live GmailMailbox that lacks a MailAccount. Returns how many
 *  bridges were created/repaired. Used by the recurring sync sweep. */
export async function ensureAllMailAccountBridges(): Promise<number> {
  const mailboxes = await db.gmailMailbox.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      agentId: true,
      address: true,
      isDefault: true,
      watchExpiresAt: true,
      mailAccount: { select: { id: true, deletedAt: true } },
    },
  })
  let bridged = 0
  for (const mb of mailboxes) {
    if (mb.mailAccount && !mb.mailAccount.deletedAt) continue
    await ensureMailAccountBridge(mb)
    bridged += 1
  }
  return bridged
}
