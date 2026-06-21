// Communications Hub — multi-account mail accounts (ADR 0021, Phase 1).
//
// `MailAccount` is the provider-agnostic unit of "a connected inbox" — personal
// (one agent) or shared (a team inbox: info@, admissions@, …). This router is
// the management surface: list / get / create-shared / update / set-default /
// disconnect / membership, plus `syncFromGmail` which imports the caller's
// existing GmailMailbox rows as personal accounts (reuse, not rebuild).
//
// RBAC + attribute checks (CLAUDE.md §20): shared inboxes are org resources
// (Manager+); a personal account is managed by its owner. Every write audited.
// Secrets never touch this layer — they stay in EncryptedField (§21).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  CreateSharedMailAccountInput,
  MailAccountIdInput,
  MailAccountMemberInput,
  UpdateMailAccountInput,
  isConnectableProvider,
  listMailProviders,
  mailProviderLabel,
  normaliseEmail,
  pickSignatureForAddress,
} from '@studymind/core/mail'
import { createClientForAgent } from '@studymind/integration-gmail/client'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
  type UserRole,
} from '@/lib/trpc/builders'

// Shared inboxes are organisation resources — Manager+ creates them and manages
// who can access them. Personal accounts are managed by their owner (attribute
// check below). Virtual Assistant is read-only on this surface.
const MANAGE_SHARED_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

function canManageShared(role: UserRole): boolean {
  return MANAGE_SHARED_ROLES.has(role)
}

interface OwnableAccount {
  ownerKind: 'personal' | 'shared'
  ownerUserId: string | null
}

function isOwner(user: SessionUser, account: OwnableAccount): boolean {
  return account.ownerKind === 'personal' && account.ownerUserId === user.id
}

/** Manager+ on any account, or the owner of a personal account. */
function assertCanManageAccount(user: SessionUser, account: OwnableAccount): void {
  if (canManageShared(user.role) || isOwner(user, account)) return
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'You cannot manage this mail account.',
  })
}

// Prisma row → view-model. Expects `team` + `_count.members` included.
interface MailAccountRow {
  id: string
  provider: 'gmail' | 'google_workspace' | 'outlook' | 'exchange' | 'imap'
  address: string
  displayName: string | null
  ownerKind: 'personal' | 'shared'
  ownerUserId: string | null
  teamId: string | null
  status: 'connected' | 'needs_reconnect' | 'disconnected' | 'error'
  isDefault: boolean
  gmailMailboxId: string | null
  watchExpiresAt: Date | null
  lastSyncedAt: Date | null
  createdAt: Date
  team?: { name: string } | null
  _count?: { members: number }
}

function toView(row: MailAccountRow) {
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: mailProviderLabel(row.provider),
    connectable: isConnectableProvider(row.provider),
    address: row.address,
    displayName: row.displayName,
    ownerKind: row.ownerKind,
    ownerUserId: row.ownerUserId,
    teamId: row.teamId,
    teamName: row.team?.name ?? null,
    status: row.status,
    isDefault: row.isDefault,
    gmailMailboxId: row.gmailMailboxId,
    memberCount: row._count?.members ?? 0,
    watchExpiresAt: row.watchExpiresAt,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
  }
}

const VIEW_INCLUDE = {
  team: { select: { name: true } },
  _count: { select: { members: true } },
} as const

export const mailAccountRouter = router({
  /** Provider capability registry — drives the connect UI. */
  providers: protectedProcedure.query(() => listMailProviders()),

  /**
   * Accounts visible to the caller: Manager+ sees everything; everyone else
   * sees their own personal accounts plus any shared inbox they are a member
   * of. Default first, then personal before shared, then by address.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const me = requireUser(ctx)
    let where: Record<string, unknown> = { deletedAt: null }
    if (!canManageShared(me.role)) {
      const memberOf = await ctx.db.mailAccountMember.findMany({
        where: { userId: me.id },
        select: { mailAccountId: true },
      })
      where = {
        deletedAt: null,
        OR: [
          { ownerUserId: me.id },
          { id: { in: memberOf.map((m) => m.mailAccountId) } },
        ],
      }
    }
    const rows = await ctx.db.mailAccount.findMany({
      where,
      orderBy: [
        { isDefault: 'desc' },
        { ownerKind: 'asc' },
        { address: 'asc' },
      ],
      include: VIEW_INCLUDE,
    })
    return rows.map(toView)
  }),

  /** One account plus its shared-inbox members (Manager+, owner, or member). */
  get: protectedProcedure
    .input(MailAccountIdInput)
    .query(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      const row = await ctx.db.mailAccount.findFirst({
        where: { id: input.id, deletedAt: null },
        include: VIEW_INCLUDE,
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })

      const members = await ctx.db.mailAccountMember.findMany({
        where: { mailAccountId: row.id },
        select: { id: true, userId: true, access: true },
      })
      const isMember = members.some((m) => m.userId === me.id)
      if (!canManageShared(me.role) && !isOwner(me, row) && !isMember) {
        // Don't leak existence to someone with no access.
        throw new TRPCError({ code: 'NOT_FOUND' })
      }

      const userIds = members.map((m) => m.userId)
      const users =
        userIds.length > 0
          ? await ctx.db.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, email: true, name: true },
            })
          : []
      const userMap = new Map(users.map((u) => [u.id, u]))
      return {
        ...toView(row),
        members: members.map((m) => ({
          id: m.id,
          userId: m.userId,
          access: m.access,
          email: userMap.get(m.userId)?.email ?? null,
          name: userMap.get(m.userId)?.name ?? null,
        })),
      }
    }),

  /**
   * Register a shared team inbox. Creates the record only — the provider
   * connection (OAuth) is a later phase, so the account starts `disconnected`.
   * Reviving a previously-disconnected address is idempotent.
   */
  createShared: auditedProcedure
    .input(CreateSharedMailAccountInput)
    .mutation(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      if (!canManageShared(me.role)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only Manager and above can create shared inboxes.',
        })
      }
      const address = normaliseEmail(input.address)
      const existing = await ctx.db.mailAccount.findUnique({
        where: { address },
        select: { id: true, deletedAt: true },
      })
      if (existing && !existing.deletedAt) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A mail account already exists for that address.',
        })
      }

      const data = {
        provider: input.provider,
        address,
        displayName: input.displayName ?? null,
        ownerKind: 'shared' as const,
        ownerUserId: me.id,
        teamId: input.teamId ?? null,
        status: 'disconnected' as const,
        isDefault: false,
        deletedAt: null,
        updatedById: me.id,
      }
      const saved = existing
        ? await ctx.db.mailAccount.update({ where: { id: existing.id }, data })
        : await ctx.db.mailAccount.create({
            data: { id: createId(), createdById: me.id, ...data },
          })

      await ctx.audit({
        action: 'mail_account.created',
        target: { type: 'MailAccount', id: saved.id },
        after: { address, provider: input.provider, ownerKind: 'shared' },
      })
      return { id: saved.id }
    }),

  /** Edit display name / status / team / owner-kind. */
  update: auditedProcedure
    .input(UpdateMailAccountInput)
    .mutation(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      const before = await ctx.db.mailAccount.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      assertCanManageAccount(me, before)

      // Reclassifying personal ↔ shared is an org-level change (Manager+).
      if (
        input.ownerKind !== undefined &&
        input.ownerKind !== before.ownerKind &&
        !canManageShared(me.role)
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only Manager and above can change ownership kind.',
        })
      }

      const after = await ctx.db.mailAccount.update({
        where: { id: input.id },
        data: {
          displayName:
            input.displayName === undefined ? undefined : input.displayName,
          status: input.status ?? undefined,
          teamId: input.teamId === undefined ? undefined : input.teamId,
          ownerKind: input.ownerKind ?? undefined,
          updatedById: me.id,
        },
      })
      await ctx.audit({
        action: 'mail_account.updated',
        target: { type: 'MailAccount', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  /** Set the caller's default send-from mailbox (personal accounts only). */
  setDefault: auditedProcedure
    .input(MailAccountIdInput)
    .mutation(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      const account = await ctx.db.mailAccount.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!account) throw new TRPCError({ code: 'NOT_FOUND' })
      if (account.ownerKind !== 'personal' || account.ownerUserId !== me.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only your own personal mailbox can be a default.',
        })
      }
      await ctx.db.$transaction([
        ctx.db.mailAccount.updateMany({
          where: { ownerUserId: me.id, ownerKind: 'personal', isDefault: true },
          data: { isDefault: false, updatedById: me.id },
        }),
        ctx.db.mailAccount.update({
          where: { id: input.id },
          data: { isDefault: true, updatedById: me.id },
        }),
      ])
      await ctx.audit({
        action: 'mail_account.default_changed',
        target: { type: 'MailAccount', id: input.id },
        after: { isDefault: true },
      })
      return { id: input.id }
    }),

  /**
   * Soft-disconnect: removes the hub's representation of the account. For a
   * connected Gmail account the actual Google revoke + watch teardown stays in
   * `oauth.gmail.disconnect` (Phase 2 unifies these); this marks the hub row
   * disconnected so it leaves the list.
   */
  disconnect: auditedProcedure
    .input(MailAccountIdInput)
    .mutation(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      const before = await ctx.db.mailAccount.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      assertCanManageAccount(me, before)
      await ctx.db.mailAccount.update({
        where: { id: input.id },
        data: {
          status: 'disconnected',
          deletedAt: new Date(),
          isDefault: false,
          updatedById: me.id,
        },
      })
      await ctx.audit({
        action: 'mail_account.disconnected',
        target: { type: 'MailAccount', id: input.id },
        before,
      })
      return { id: input.id }
    }),

  members: router({
    list: protectedProcedure
      .input(z.object({ mailAccountId: z.string() }))
      .query(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        const account = await ctx.db.mailAccount.findFirst({
          where: { id: input.mailAccountId, deletedAt: null },
          select: { id: true, ownerKind: true, ownerUserId: true },
        })
        if (!account) throw new TRPCError({ code: 'NOT_FOUND' })
        const members = await ctx.db.mailAccountMember.findMany({
          where: { mailAccountId: account.id },
          select: { id: true, userId: true, access: true },
        })
        if (
          !canManageShared(me.role) &&
          !isOwner(me, account) &&
          !members.some((m) => m.userId === me.id)
        ) {
          throw new TRPCError({ code: 'NOT_FOUND' })
        }
        const users =
          members.length > 0
            ? await ctx.db.user.findMany({
                where: { id: { in: members.map((m) => m.userId) } },
                select: { id: true, email: true, name: true },
              })
            : []
        const userMap = new Map(users.map((u) => [u.id, u]))
        return members.map((m) => ({
          id: m.id,
          userId: m.userId,
          access: m.access,
          email: userMap.get(m.userId)?.email ?? null,
          name: userMap.get(m.userId)?.name ?? null,
        }))
      }),

    add: auditedProcedure
      .input(MailAccountMemberInput)
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        if (!canManageShared(me.role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only Manager and above can manage shared-inbox access.',
          })
        }
        const account = await ctx.db.mailAccount.findFirst({
          where: { id: input.mailAccountId, deletedAt: null },
          select: { id: true, ownerKind: true },
        })
        if (!account) throw new TRPCError({ code: 'NOT_FOUND' })
        if (account.ownerKind !== 'shared') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Members can only be added to shared inboxes.',
          })
        }
        const member = await ctx.db.mailAccountMember.upsert({
          where: {
            mailAccountId_userId: {
              mailAccountId: input.mailAccountId,
              userId: input.userId,
            },
          },
          create: {
            id: createId(),
            mailAccountId: input.mailAccountId,
            userId: input.userId,
            access: input.access,
            createdById: me.id,
          },
          update: { access: input.access },
        })
        await ctx.audit({
          action: 'mail_account.member_added',
          target: { type: 'MailAccount', id: input.mailAccountId },
          after: { memberId: member.id, userId: input.userId, access: input.access },
        })
        return { id: member.id }
      }),

    remove: auditedProcedure
      .input(z.object({ mailAccountId: z.string(), userId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        if (!canManageShared(me.role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only Manager and above can manage shared-inbox access.',
          })
        }
        const member = await ctx.db.mailAccountMember.findUnique({
          where: {
            mailAccountId_userId: {
              mailAccountId: input.mailAccountId,
              userId: input.userId,
            },
          },
        })
        if (!member) throw new TRPCError({ code: 'NOT_FOUND' })
        await ctx.db.mailAccountMember.delete({ where: { id: member.id } })
        await ctx.audit({
          action: 'mail_account.member_removed',
          target: { type: 'MailAccount', id: input.mailAccountId },
          before: { memberId: member.id, userId: input.userId },
        })
        return { id: member.id }
      }),
  }),

  /**
   * Import the caller's connected Gmail mailboxes as personal MailAccounts.
   * Idempotent: upserts on the GmailMailbox bridge so re-running converges.
   * Reuses the existing Gmail integration rather than rebuilding it (ADR 0021).
   */
  syncFromGmail: auditedProcedure.mutation(async ({ ctx }) => {
    const me = requireUser(ctx)
    const [mailboxes, user] = await Promise.all([
      ctx.db.gmailMailbox.findMany({
        where: { agentId: me.id, deletedAt: null },
        select: { id: true, address: true, isDefault: true, watchExpiresAt: true },
      }),
      ctx.db.user.findUnique({
        where: { id: me.id },
        select: { gmailConnectionStatus: true },
      }),
    ])

    const status =
      user?.gmailConnectionStatus === 'connected'
        ? ('connected' as const)
        : user?.gmailConnectionStatus === 'needs_reconnect'
          ? ('needs_reconnect' as const)
          : ('disconnected' as const)

    // Best-effort: copy the agent's Gmail signature(s) so outgoing CRM mail
    // matches Gmail. Readable with our existing scopes; a failure (e.g. a
    // disconnected/needs-reconnect token) must never block the import — we just
    // leave signatures untouched and the user can re-sync after reconnecting.
    let sendAs: Awaited<ReturnType<Awaited<ReturnType<typeof createClientForAgent>>['listSendAs']>> | null =
      null
    if (status === 'connected') {
      try {
        const client = await createClientForAgent({
          agentId: me.id,
          purpose: 'mail.sync_signature',
          requestId: ctx.requestId,
        })
        sendAs = await client.listSendAs()
      } catch {
        sendAs = null
      }
    }

    let imported = 0
    for (const mb of mailboxes) {
      const address = normaliseEmail(mb.address)
      const byBridge = await ctx.db.mailAccount.findUnique({
        where: { gmailMailboxId: mb.id },
        select: { id: true },
      })
      const common = {
        provider: 'gmail' as const,
        ownerKind: 'personal' as const,
        ownerUserId: me.id,
        address,
        status,
        isDefault: mb.isDefault,
        watchExpiresAt: mb.watchExpiresAt,
        deletedAt: null,
        updatedById: me.id,
        // Only touch the signature when we actually read sendAs — otherwise a
        // transient fetch failure would wipe a previously-synced signature.
        ...(sendAs
          ? {
              signatureHtml: pickSignatureForAddress(sendAs, address),
              signatureSyncedAt: new Date(),
            }
          : {}),
      }
      if (byBridge) {
        await ctx.db.mailAccount.update({ where: { id: byBridge.id }, data: common })
      } else {
        const byAddress = await ctx.db.mailAccount.findUnique({
          where: { address },
          select: { id: true },
        })
        if (byAddress) {
          await ctx.db.mailAccount.update({
            where: { id: byAddress.id },
            data: { ...common, gmailMailboxId: mb.id },
          })
        } else {
          await ctx.db.mailAccount.create({
            data: {
              id: createId(),
              gmailMailboxId: mb.id,
              createdById: me.id,
              ...common,
            },
          })
        }
      }
      imported += 1
    }

    await ctx.audit({
      action: 'mail_account.imported',
      target: { type: 'User', id: me.id },
      after: { imported, source: 'gmail' },
    })
    return { imported }
  }),

  /**
   * Resync this account's existing email threads FROM Gmail — re-reads each
   * thread's current archive/read/star/trash state + custom labels and converges
   * the Conversation heads onto Gmail. Fixes heads synced before flag/label
   * capture (every thread showing as "Inbox", no label chips). Head-only — never
   * writes timeline rows — so it's safe to run repeatedly. Owner or Manager+.
   */
  resyncFromGmail: auditedProcedure
    .input(MailAccountIdInput)
    .mutation(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      const account = await ctx.db.mailAccount.findFirst({
        where: { id: input.id, deletedAt: null },
        select: {
          id: true,
          provider: true,
          ownerKind: true,
          ownerUserId: true,
          gmailMailboxId: true,
        },
      })
      if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
      assertCanManageAccount(me, account)
      if (account.provider !== 'gmail' || !account.gmailMailboxId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only connected Gmail accounts can be resynced today.',
        })
      }
      const mailbox = await ctx.db.gmailMailbox.findFirst({
        where: { id: account.gmailMailboxId, deletedAt: null },
        select: { id: true, agentId: true, address: true },
      })
      if (!mailbox) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No connected Gmail mailbox.' })
      }

      const { inngest } = await import('@studymind/jobs')
      await inngest.send({
        name: 'gmail/resync-threads.requested',
        data: {
          mailAccountId: account.id,
          gmailMailboxId: mailbox.id,
          agentId: mailbox.agentId,
          address: mailbox.address,
          requestId: ctx.requestId,
          cursor: null,
        },
      })
      await ctx.audit({
        action: 'mail_account.resync_requested',
        target: { type: 'MailAccount', id: account.id },
        after: { source: 'gmail' },
      })
      return { ok: true as const }
    }),
})
