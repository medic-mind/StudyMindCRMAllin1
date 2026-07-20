// Admin → Users router. CLAUDE.md §20 (RBAC), §27 (audit context), ADR 0014,
// ADR 0010, ADR 0021.
//
// Manages user identity for the self-hosted auth flow:
//   - list / get with status (active | invited | deactivated | locked)
//   - create (temp password + welcome PDF; user must reset on first login)
//   - invite (legacy email-link path; user sets their own password)
//   - update details (name) and change email
//   - resetPassword (admin-issued temp password + email/PDF)
//   - grant / revoke the `user.manage` permission to an individual
//   - assign / revoke roles, gated by canGrantRole / canRevokeRole
//   - deactivate / reactivate
//
// Authorization (ADR 0021):
//   - CREATE accounts: CEO + Senior Manager only (`user.invite`).
//   - MANAGE (edit details / change email / reset password): CEO, Senior
//     Manager, Manager — OR any individual granted `user.manage`.
//   - DELEGATE the manage permission: CEO, Senior Manager, Manager.
//   - DEACTIVATE / ROLE changes: CEO + Senior Manager only.
// A non-(CEO/Senior Manager) actor can never act on a CEO or Senior Manager.
// Every mutation is audited.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ACTION_GROUPS,
  ACTION_LABELS,
  ACTIONS,
  ASSIGNABLE_ACTIONS,
  GRANTABLE_ACTIONS,
  canCreateUsers,
  canCreateUserAtRole,
  canDeactivateUsers,
  canGrantRole,
  canGrantUserManage,
  canManageUsers,
  canRevokeRole,
  hasAction,
  isAssignableAction,
  normaliseRole,
  pickPrimaryRole,
  roleCan,
  ROLES,
  sanitizeRolePermissions,
  type Action,
  type Role,
} from '@studymind/core/auth/policies'
import { assertNotLastCeo } from '@studymind/core/auth/guards'

import { loadEffectiveGrants } from '@/lib/auth/effective-grants'
import {
  assertStrongPassword,
  generateTemporaryPassword,
  generateToken,
  hashPassword,
  hashToken,
} from '@studymind/core/auth/passwords'
import {
  buildLoginReminderEmail,
  buildWelcomeEmail,
  buildWelcomePdf,
  WELCOME_PDF_FILENAME,
  type WelcomeCredentials,
} from '@studymind/core/email'
import { BusinessError } from '@studymind/core/errors'
import { logger } from '@studymind/core/logger'
import { resolveSystemAgentId, sendSystemEmail } from '@studymind/integration-gmail/system-send'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type AuthedTrpcContext,
  type SessionUser,
} from '@/lib/trpc/builders'

const RoleEnum = z.enum(ROLES)
const GrantableEnum = z.enum(GRANTABLE_ACTIONS)

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function appUrl(): string {
  return (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

/* -------------------------------------------------------------------------- */
/* authorization helpers                                                       */
/* -------------------------------------------------------------------------- */

type Db = AuthedTrpcContext['db']

/** Load the actor's granted (non-role) permissions, e.g. `user.manage`. */
async function loadActorGrants(db: Db, userId: string): Promise<string[]> {
  // Per-user grants ∪ assigned custom-role permissions, so a custom role that
  // grants `user.manage` is honoured here too (§20).
  return loadEffectiveGrants(db, userId)
}

/** CEO + Senior Manager only. */
function assertCanCreateUsers(actor: SessionUser): void {
  if (!canCreateUsers(actor.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a CEO or Senior Manager can create accounts.' })
  }
}

/** CEO + Senior Manager only. */
function assertCanDeactivate(actor: SessionUser): void {
  if (!canDeactivateUsers(actor.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a CEO or Senior Manager can deactivate users.' })
  }
}

/** Role grant OR a `user.manage` permission. */
function assertCanManage(actor: SessionUser, grants: readonly string[]): void {
  if (!canManageUsers(actor.role, grants)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to manage users.' })
  }
}

/**
 * A non-(CEO/Senior Manager) actor — i.e. a Manager or a permission-holder —
 * may not edit, reset, or otherwise act on a CEO or Senior Manager. Prevents
 * a delegated permission from escalating into control over leadership accounts.
 */
function assertCanActOnTarget(actor: SessionUser, targetRoles: readonly string[]): void {
  if (actor.role === 'ceo' || actor.role === 'senior_manager') return
  const canonical = targetRoles.map((r) => normaliseRole(r) ?? ('virtual_assistant' as Role))
  if (canonical.some((r) => r === 'ceo' || r === 'senior_manager')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You cannot manage a CEO or Senior Manager account.',
    })
  }
}

/* -------------------------------------------------------------------------- */
/* status                                                                      */
/* -------------------------------------------------------------------------- */

interface UserStatusInput {
  passwordHash: string | null
  emailVerifiedAt: Date | null
  deactivatedAt: Date | null
  lockedUntil: Date | null
}

function deriveStatus(u: UserStatusInput): 'active' | 'invited' | 'deactivated' | 'locked' {
  if (u.deactivatedAt) return 'deactivated'
  if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) return 'locked'
  if (!u.passwordHash) return 'invited'
  return 'active'
}

/* -------------------------------------------------------------------------- */
/* temporary-credential issuance (shared by create + resetPassword)            */
/* -------------------------------------------------------------------------- */

interface IssueArgs {
  userId: string
  email: string
  name: string | null
  actorName: string
  isReset: boolean
  invalidateSessions: boolean
  /** Explicit admin-chosen password. When omitted, a strong one is generated. */
  password?: string
  /** Force a change on first sign-in. Defaults to true. */
  requireChange?: boolean
}

/**
 * Set a password on the user (admin-chosen or generated), optionally force a
 * reset on next sign-in, mark the email verified (an admin vouches for the
 * address), and email the branded welcome/reset message with the credentials
 * PDF attached. Returns the plaintext password so the caller can surface it to
 * the admin — useful while the outbound mailbox is still being connected, or
 * when the user has lost access to their email. The password is never logged.
 */
async function issueTemporaryCredentials(
  db: Db,
  actor: SessionUser,
  args: IssueArgs,
): Promise<{ temporaryPassword: string; emailStatus: 'sent' | 'skipped' | 'failed' }> {
  const temporaryPassword = args.password ?? generateTemporaryPassword()
  const passwordHash = await hashPassword(temporaryPassword)
  const now = new Date()

  await db.user.update({
    where: { id: args.userId },
    data: {
      passwordHash,
      mustResetPassword: args.requireChange ?? true,
      emailVerifiedAt: now,
      failedSignInAttempts: 0,
      lockedUntil: null,
      isActive: true,
      updatedById: actor.id,
    },
  })

  if (args.invalidateSessions) {
    // Force any current sessions to re-authenticate and burn outstanding
    // self-service reset links so only the new temp password works.
    await db.session.deleteMany({ where: { userId: args.userId } })
    await db.passwordResetToken.updateMany({
      where: { userId: args.userId, usedAt: null },
      data: { usedAt: now },
    })
  }

  const creds: WelcomeCredentials = {
    name: args.name,
    email: args.email,
    temporaryPassword,
    signInUrl: `${appUrl()}/sign-in`,
    inviterName: args.actorName,
    isReset: args.isReset,
  }
  const rendered = buildWelcomeEmail(creds)
  const pdf = buildWelcomePdf(creds)

  const sendResult = await sendSystemEmail({
    to: args.email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: [
      {
        filename: WELCOME_PDF_FILENAME,
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  })
  if (sendResult.status === 'failed') {
    logger.error({ detail: sendResult.detail }, 'admin.users.welcome.email_send_failed')
  }

  return { temporaryPassword, emailStatus: sendResult.status }
}

/* -------------------------------------------------------------------------- */
/* shared account creation (used by create + bulkCreate)                       */
/* -------------------------------------------------------------------------- */

interface CreateArgs {
  /** Already normalised: trimmed + lowercased. */
  email: string
  roles: Role[]
  name?: string | null
  /** Explicit password; omit to generate a strong temporary one. */
  password?: string
  requireChange: boolean
}

/**
 * Create (or finish inviting) one staff account: upsert the User, attach the
 * requested roles, issue a temporary password, email the branded welcome +
 * credentials PDF, and write the `auth.user_created` audit row. Throws CONFLICT
 * when a fully-provisioned user already owns the email. Shared by `create` (one
 * account) and `bulkCreate` (many at once) so the invitation path is identical.
 * Callers are responsible for the authorization checks (create rights + per-role
 * grant) before calling.
 */
async function createUserWithCredentials(
  ctx: { db: Db; audit: AuthedTrpcContext['audit'] },
  actor: SessionUser,
  args: CreateArgs,
): Promise<{ userId: string; temporaryPassword: string; emailStatus: 'sent' | 'skipped' | 'failed' }> {
  const existing = await ctx.db.user.findUnique({ where: { email: args.email } })
  if (existing && existing.passwordHash) {
    throw new TRPCError({ code: 'CONFLICT', message: 'A user with that email already exists.' })
  }

  const userId = existing?.id ?? createId()
  if (!existing) {
    await ctx.db.user.create({
      data: {
        id: userId,
        email: args.email,
        name: args.name ?? null,
        passwordHash: null,
        emailVerifiedAt: null,
        mustResetPassword: false,
        createdById: actor.id,
        updatedById: actor.id,
      },
    })
  } else if (args.name && !existing.name) {
    await ctx.db.user.update({
      where: { id: existing.id },
      data: { name: args.name, updatedById: actor.id },
    })
  }

  for (const role of args.roles) {
    const present = await ctx.db.roleAssignment.findUnique({
      where: { userId_role: { userId, role } },
      select: { id: true },
    })
    if (!present) {
      await ctx.db.roleAssignment.create({
        data: { id: createId(), userId, role, createdById: actor.id, updatedById: actor.id },
      })
    }
  }

  const { temporaryPassword, emailStatus } = await issueTemporaryCredentials(ctx.db, actor, {
    userId,
    email: args.email,
    name: args.name ?? existing?.name ?? null,
    actorName: actor.email,
    isReset: false,
    invalidateSessions: false,
    password: args.password,
    requireChange: args.requireChange,
  })

  await ctx.audit({
    action: 'auth.user_created',
    target: { type: 'User', id: userId },
    after: { email: args.email, roles: args.roles },
  })

  return { userId, temporaryPassword, emailStatus }
}

export const adminUsersRouter = router({
  /* ------------------------------------------------------------------ */
  /* myAccess — capabilities of the current caller (drives UI gating)    */
  /* ------------------------------------------------------------------ */
  myAccess: protectedProcedure.query(async ({ ctx }) => {
    const actor = requireUser(ctx)
    const grants = await loadActorGrants(ctx.db, actor.id)
    // Whether a system Gmail mailbox is connected to actually send the welcome
    // / reset emails. When false the UI nudges the admin to copy + share the
    // temporary password and connect Gmail.
    const systemEmailReady = (await resolveSystemAgentId()) !== null
    return {
      role: actor.role,
      canCreate: canCreateUsers(actor.role),
      canManage: canManageUsers(actor.role, grants),
      canGrantManage: canGrantUserManage(actor.role),
      canDeactivate: canDeactivateUsers(actor.role),
      canManageRoles: ROLES.some((r) => canGrantRole(actor.role, r)),
      // Delete (soft, reversible) is CEO + Senior Manager; permanent erase is
      // CEO only; per-user permission grants are CEO + Senior Manager.
      canDelete: canDeactivateUsers(actor.role),
      canErase: actor.role === 'ceo',
      canSetPermissions: actor.role === 'ceo' || actor.role === 'senior_manager',
      systemEmailReady,
    }
  }),

  /* ------------------------------------------------------------------ */
  /* list                                                                */
  /* ------------------------------------------------------------------ */
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().trim().min(1).optional(),
        /** Show soft-deleted accounts instead of live ones (the "Deleted" view). */
        deleted: z.boolean().default(false),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManage(actor, await loadActorGrants(ctx.db, actor.id))
      const where = {
        deletedAt: input.deleted ? { not: null } : null,
        ...(input.search
          ? {
              OR: [
                { email: { contains: input.search, mode: 'insensitive' as const } },
                { name: { contains: input.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      }
      const rows = await ctx.db.user.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { email: 'asc' },
        select: {
          id: true,
          email: true,
          name: true,
          avatarKey: true,
          isActive: true,
          passwordHash: true,
          emailVerifiedAt: true,
          deactivatedAt: true,
          deletedAt: true,
          lockedUntil: true,
          lastSignInAt: true,
          loginReminderCount: true,
          mustResetPassword: true,
          roleAssignments: { select: { id: true, role: true } },
          permissions: { select: { permission: true } },
        },
      })
      const hasMore = rows.length > input.limit
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        avatarKey: u.avatarKey,
        isActive: u.isActive,
        lastSignInAt: u.lastSignInAt,
        deleted: Boolean(u.deletedAt),
        loginReminderCount: u.loginReminderCount,
        // A temp-password account that has never signed in is technically
        // "active" but awaits first login — surface that to the UI.
        awaitingFirstSignIn: Boolean(u.passwordHash) && u.mustResetPassword && !u.lastSignInAt,
        status: u.deletedAt ? ('deleted' as const) : deriveStatus(u),
        roles: u.roleAssignments.map((r) => ({
          id: r.id,
          role: normaliseRole(r.role) ?? ('virtual_assistant' as Role),
        })),
        extraPermissions: u.permissions.map((p) => p.permission),
      }))
      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      }
    }),

  /* ------------------------------------------------------------------ */
  /* get                                                                 */
  /* ------------------------------------------------------------------ */
  get: protectedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManage(actor, await loadActorGrants(ctx.db, actor.id))
      const u = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          passwordHash: true,
          emailVerifiedAt: true,
          deactivatedAt: true,
          deactivationReason: true,
          lockedUntil: true,
          failedSignInAttempts: true,
          lastSignInAt: true,
          lastSignInIp: true,
          mustResetPassword: true,
          roleAssignments: { select: { id: true, role: true } },
          permissions: { select: { permission: true } },
          sessions: { select: { id: true } },
        },
      })
      if (!u) throw new TRPCError({ code: 'NOT_FOUND' })
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        isActive: u.isActive,
        deactivationReason: u.deactivationReason,
        lastSignInAt: u.lastSignInAt,
        lastSignInIp: u.lastSignInIp,
        mustResetPassword: u.mustResetPassword,
        failedSignInAttempts: u.failedSignInAttempts,
        sessionCount: u.sessions.length,
        status: deriveStatus(u),
        roles: u.roleAssignments.map((r) => ({
          id: r.id,
          role: normaliseRole(r.role) ?? ('virtual_assistant' as Role),
        })),
        extraPermissions: u.permissions.map((p) => p.permission),
      }
    }),

  /* ------------------------------------------------------------------ */
  /* create — temp password + welcome PDF (ADR 0021, primary path)       */
  /* ------------------------------------------------------------------ */
  // Like resetPassword: omit `password` to generate a strong temporary one
  // (emailed + PDF), or pass `password` to set a specific one yourself (e.g.
  // when the new user can't receive email). `requireChange` (default true)
  // forces a change on first sign-in.
  create: auditedProcedure
    .input(
      z.object({
        email: z.string().email(),
        roles: z.array(RoleEnum).min(1),
        name: z.string().trim().min(1).max(200).optional(),
        password: z.string().optional(),
        requireChange: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanCreateUsers(actor)
      const email = input.email.trim().toLowerCase()

      for (const role of input.roles) {
        if (!canCreateUserAtRole(actor.role, role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: `cannot grant role: ${role}` })
        }
      }

      // Validate an admin-chosen password against the same strength policy.
      if (input.password !== undefined) {
        try {
          assertStrongPassword(input.password)
        } catch (e) {
          if (e instanceof BusinessError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: e.message })
          }
          throw e
        }
      }

      const { userId, temporaryPassword, emailStatus } = await createUserWithCredentials(
        ctx,
        actor,
        {
          email,
          roles: input.roles,
          name: input.name,
          password: input.password,
          requireChange: input.requireChange,
        },
      )

      return { userId, email, temporaryPassword, emailStatus }
    }),

  /* ------------------------------------------------------------------ */
  /* bulkCreate — invite many at once from a list of emails             */
  /* ------------------------------------------------------------------ */
  // Paste/type a list of emails and grant them all the same role(s). Each
  // address runs the exact same invitation path as `create` (temp password +
  // welcome email + PDF, forced reset on first login). One bad/duplicate/
  // already-existing address never aborts the batch — the result reports a
  // per-email outcome. CEO + Senior Manager only, like single create.
  bulkCreate: auditedProcedure
    .input(
      z.object({
        emails: z.array(z.string()).min(1).max(200),
        roles: z.array(RoleEnum).min(1),
        requireChange: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanCreateUsers(actor)
      for (const role of input.roles) {
        if (!canCreateUserAtRole(actor.role, role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: `cannot grant role: ${role}` })
        }
      }

      const emailSchema = z.string().email()
      const seen = new Set<string>()
      const results: Array<{
        email: string
        status: 'created' | 'skipped' | 'duplicate' | 'invalid' | 'failed'
        emailStatus?: 'sent' | 'skipped' | 'failed'
        userId?: string
      }> = []

      for (const raw of input.emails) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        const email = trimmed.toLowerCase()
        if (!emailSchema.safeParse(email).success) {
          results.push({ email: trimmed, status: 'invalid' })
          continue
        }
        if (seen.has(email)) {
          results.push({ email, status: 'duplicate' })
          continue
        }
        seen.add(email)
        try {
          const r = await createUserWithCredentials(ctx, actor, {
            email,
            roles: input.roles,
            requireChange: input.requireChange,
          })
          results.push({ email, status: 'created', userId: r.userId, emailStatus: r.emailStatus })
        } catch (e) {
          if (e instanceof TRPCError && e.code === 'CONFLICT') {
            results.push({ email, status: 'skipped' })
          } else {
            logger.error(
              { detail: e instanceof Error ? e.message : String(e) },
              'admin.users.bulk_create.row_failed',
            )
            results.push({ email, status: 'failed' })
          }
        }
      }

      const summary = {
        created: results.filter((r) => r.status === 'created').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        duplicate: results.filter((r) => r.status === 'duplicate').length,
        invalid: results.filter((r) => r.status === 'invalid').length,
        failed: results.filter((r) => r.status === 'failed').length,
      }

      // Always write a summary audit row — this is also the auditedProcedure
      // backstop's required ctx.audit call when nothing was created (every
      // address skipped/invalid). Per-account rows are written by the helper.
      await ctx.audit({
        action: 'auth.users_bulk_created',
        target: { type: 'User', id: actor.id },
        after: { roles: input.roles, ...summary },
      })

      return { results, summary }
    }),

  /* ------------------------------------------------------------------ */
  /* update — name + email                                               */
  /* ------------------------------------------------------------------ */
  update: auditedProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        name: z.string().trim().min(1).max(200).optional(),
        email: z.string().email().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManage(actor, await loadActorGrants(ctx.db, actor.id))
      if (input.name === undefined && input.email === undefined) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nothing to update.' })
      }
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: {
          id: true,
          email: true,
          name: true,
          roleAssignments: { select: { role: true } },
        },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })
      assertCanActOnTarget(actor, target.roleAssignments.map((r) => r.role))

      const data: { name?: string; email?: string; updatedById: string } = { updatedById: actor.id }
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}

      if (input.name !== undefined && input.name !== target.name) {
        data.name = input.name
        before['name'] = target.name
        after['name'] = input.name
      }
      if (input.email !== undefined) {
        const email = input.email.trim().toLowerCase()
        if (email !== target.email) {
          const clash = await ctx.db.user.findUnique({ where: { email }, select: { id: true } })
          if (clash && clash.id !== target.id) {
            throw new TRPCError({ code: 'CONFLICT', message: 'That email is already in use.' })
          }
          data.email = email
          before['email'] = target.email
          after['email'] = email
        }
      }

      const changed = data.name !== undefined || data.email !== undefined
      if (changed) {
        await ctx.db.user.update({ where: { id: target.id }, data })
      }
      await ctx.audit({
        action: 'auth.user_updated',
        target: { type: 'User', id: target.id },
        before,
        after,
      })
      return { ok: true, changed }
    }),

  /* ------------------------------------------------------------------ */
  /* resetPassword — generate a temp password, or set one manually        */
  /* ------------------------------------------------------------------ */
  // Two ways to reset (ADR 0021): omit `password` to generate a strong
  // temporary one (emailed + PDF), or pass `password` to set a specific one
  // yourself — useful when the user has lost access to their email and you
  // need to give them working credentials directly. `requireChange` (default
  // true) forces a change on first sign-in.
  resetPassword: auditedProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        password: z.string().optional(),
        requireChange: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManage(actor, await loadActorGrants(ctx.db, actor.id))
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: {
          id: true,
          email: true,
          name: true,
          deactivatedAt: true,
          roleAssignments: { select: { role: true } },
        },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })
      assertCanActOnTarget(actor, target.roleAssignments.map((r) => r.role))
      if (target.deactivatedAt) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Reactivate the user before resetting their password.' })
      }

      // Validate an admin-chosen password against the same strength policy.
      if (input.password !== undefined) {
        try {
          assertStrongPassword(input.password)
        } catch (e) {
          if (e instanceof BusinessError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: e.message })
          }
          throw e
        }
      }

      const { temporaryPassword, emailStatus } = await issueTemporaryCredentials(
        ctx.db,
        actor,
        {
          userId: target.id,
          email: target.email,
          name: target.name,
          actorName: actor.email,
          isReset: true,
          invalidateSessions: true,
          password: input.password,
          requireChange: input.requireChange,
        },
      )

      await ctx.audit({
        action: 'auth.password_reset_by_admin',
        target: { type: 'User', id: target.id },
        after: { manualPassword: input.password !== undefined, requireChange: input.requireChange },
      })
      return { ok: true, email: target.email, temporaryPassword, emailStatus, requireChange: input.requireChange }
    }),

  /* ------------------------------------------------------------------ */
  /* grantPermission / revokePermission (user.manage delegation)          */
  /* ------------------------------------------------------------------ */
  grantPermission: auditedProcedure
    .input(z.object({ userId: z.string().min(1), permission: GrantableEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (!canGrantUserManage(actor.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You cannot delegate user management.' })
      }
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })

      const existing = await ctx.db.userPermission.findUnique({
        where: { userId_permission: { userId: target.id, permission: input.permission } },
        select: { id: true },
      })
      if (existing) {
        await ctx.audit({
          action: 'auth.permission_granted',
          target: { type: 'User', id: target.id },
          before: { permission: input.permission, present: true },
          after: { permission: input.permission, present: true },
        })
        return { ok: true, alreadyPresent: true }
      }
      await ctx.db.userPermission.create({
        data: {
          id: createId(),
          userId: target.id,
          permission: input.permission,
          createdById: actor.id,
        },
      })
      await ctx.audit({
        action: 'auth.permission_granted',
        target: { type: 'User', id: target.id },
        before: { permission: input.permission, present: false },
        after: { permission: input.permission, present: true },
      })
      return { ok: true, alreadyPresent: false }
    }),

  revokePermission: auditedProcedure
    .input(z.object({ userId: z.string().min(1), permission: GrantableEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (!canGrantUserManage(actor.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You cannot delegate user management.' })
      }
      const existing = await ctx.db.userPermission.findUnique({
        where: { userId_permission: { userId: input.userId, permission: input.permission } },
        select: { id: true },
      })
      if (!existing) {
        await ctx.audit({
          action: 'auth.permission_revoked',
          target: { type: 'User', id: input.userId },
          before: { permission: input.permission, present: false },
          after: { permission: input.permission, present: false },
        })
        return { ok: true, alreadyAbsent: true }
      }
      await ctx.db.userPermission.delete({ where: { id: existing.id } })
      await ctx.audit({
        action: 'auth.permission_revoked',
        target: { type: 'User', id: input.userId },
        before: { permission: input.permission, present: true },
        after: { permission: input.permission, present: false },
      })
      return { ok: true, alreadyAbsent: false }
    }),

  /* ------------------------------------------------------------------ */
  /* invite (legacy link-based path — set your own password)             */
  /* ------------------------------------------------------------------ */
  invite: auditedProcedure
    .input(
      z.object({
        email: z.string().email(),
        roles: z.array(RoleEnum).min(1),
        name: z.string().trim().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanCreateUsers(actor)
      const email = input.email.trim().toLowerCase()

      for (const role of input.roles) {
        if (!canCreateUserAtRole(actor.role, role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: `cannot grant role: ${role}` })
        }
      }

      const existing = await ctx.db.user.findUnique({ where: { email } })
      if (existing && existing.passwordHash) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A user with that email already exists.' })
      }

      const userId = existing?.id ?? createId()
      if (!existing) {
        await ctx.db.user.create({
          data: {
            id: userId,
            email,
            name: input.name ?? null,
            passwordHash: null,
            emailVerifiedAt: null,
            mustResetPassword: false,
            createdById: actor.id,
            updatedById: actor.id,
          },
        })
      } else if (input.name && !existing.name) {
        await ctx.db.user.update({
          where: { id: existing.id },
          data: { name: input.name, updatedById: actor.id },
        })
      }

      for (const role of input.roles) {
        const present = await ctx.db.roleAssignment.findUnique({
          where: { userId_role: { userId, role } },
          select: { id: true },
        })
        if (!present) {
          await ctx.db.roleAssignment.create({
            data: { id: createId(), userId, role, createdById: actor.id, updatedById: actor.id },
          })
        }
      }

      const rawToken = generateToken()
      await ctx.db.emailVerificationToken.create({
        data: {
          id: createId(),
          userId,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      })

      const link = `${appUrl()}/accept-invite?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`
      const inviteSend = await sendSystemEmail({
        to: email,
        subject: 'You have been invited to StudyMind CRM',
        text:
          `Hello${input.name ? ` ${input.name}` : ''},\n\n` +
          `${actor.email} has invited you to StudyMind CRM. ` +
          `Use the link below to set your password — it expires in 7 days.\n\n${link}\n\n` +
          `If you were not expecting this email, you can ignore it.\n\n— StudyMind CRM`,
      })
      if (inviteSend.status === 'failed') {
        logger.error({ detail: inviteSend.detail }, 'admin.users.invite.email_send_failed')
      }

      await ctx.audit({
        action: 'auth.user_invited',
        target: { type: 'User', id: userId },
        after: { email, roles: input.roles },
      })

      return { userId, email }
    }),

  /* ------------------------------------------------------------------ */
  /* resend invite                                                       */
  /* ------------------------------------------------------------------ */
  resendInvite: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanCreateUsers(actor)
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, email: true, name: true, passwordHash: true },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (user.passwordHash) {
        throw new TRPCError({ code: 'CONFLICT', message: 'User has already accepted their invite.' })
      }
      const rawToken = generateToken()
      await ctx.db.emailVerificationToken.create({
        data: {
          id: createId(),
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      })
      const link = `${appUrl()}/accept-invite?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(user.email)}`
      const resendSend = await sendSystemEmail({
        to: user.email,
        subject: 'Your StudyMind CRM invite',
        text:
          `Hello${user.name ? ` ${user.name}` : ''},\n\n` +
          `Here is a fresh invite link, valid for 7 days:\n\n${link}\n\n— StudyMind CRM`,
      })
      if (resendSend.status === 'failed') {
        logger.error({ detail: resendSend.detail }, 'admin.users.invite.email_send_failed')
      }
      await ctx.audit({
        action: 'auth.user_invite_resent',
        target: { type: 'User', id: user.id },
      })
      return { ok: true }
    }),

  /* ------------------------------------------------------------------ */
  /* cancel invite                                                       */
  /* ------------------------------------------------------------------ */
  cancelInvite: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanCreateUsers(actor)
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, passwordHash: true },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (user.passwordHash) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Cannot cancel — user has already accepted.' })
      }
      await ctx.db.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      })
      await ctx.db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date(), updatedById: actor.id },
      })
      await ctx.db.roleAssignment.deleteMany({ where: { userId: user.id } })
      await ctx.audit({
        action: 'auth.user_invite_cancelled',
        target: { type: 'User', id: user.id },
      })
      return { ok: true }
    }),

  /* ------------------------------------------------------------------ */
  /* assignRole                                                          */
  /* ------------------------------------------------------------------ */
  assignRole: auditedProcedure
    .input(z.object({ userId: z.string().min(1), role: RoleEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (!canGrantRole(actor.role, input.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `cannot grant role: ${input.role}` })
      }
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })

      const existing = await ctx.db.roleAssignment.findUnique({
        where: { userId_role: { userId: input.userId, role: input.role } },
        select: { id: true },
      })
      if (existing) {
        await ctx.audit({
          action: 'auth.role_granted',
          target: { type: 'User', id: input.userId },
          before: { role: input.role, present: true },
          after: { role: input.role, present: true },
        })
        return { id: existing.id, alreadyPresent: true }
      }
      const id = createId()
      await ctx.db.roleAssignment.create({
        data: { id, userId: input.userId, role: input.role, createdById: actor.id, updatedById: actor.id },
      })
      await ctx.audit({
        action: 'auth.role_granted',
        target: { type: 'User', id: input.userId },
        before: { role: input.role, present: false },
        after: { role: input.role, present: true },
      })
      return { id, alreadyPresent: false }
    }),

  /* ------------------------------------------------------------------ */
  /* revokeRole                                                          */
  /* ------------------------------------------------------------------ */
  revokeRole: auditedProcedure
    .input(z.object({ userId: z.string().min(1), role: RoleEnum }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (!canRevokeRole(actor.role, input.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `cannot revoke role: ${input.role}` })
      }
      if (
        actor.id === input.userId &&
        (input.role === 'ceo' || input.role === 'senior_manager')
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Cannot revoke your own ceo or senior_manager role.',
        })
      }
      if (input.role === 'ceo') {
        try {
          await assertNotLastCeo(ctx.db, input.userId)
        } catch (e) {
          if (e instanceof BusinessError && e.code === 'LAST_CEO') {
            throw new TRPCError({ code: 'CONFLICT', message: 'cannot revoke the last ceo' })
          }
          throw e
        }
      }

      const existing = await ctx.db.roleAssignment.findUnique({
        where: { userId_role: { userId: input.userId, role: input.role } },
        select: { id: true },
      })
      if (!existing) {
        await ctx.audit({
          action: 'auth.role_revoked',
          target: { type: 'User', id: input.userId },
          before: { role: input.role, present: false },
          after: { role: input.role, present: false },
        })
        return { ok: true, alreadyAbsent: true }
      }
      await ctx.db.roleAssignment.delete({ where: { id: existing.id } })
      await ctx.audit({
        action: 'auth.role_revoked',
        target: { type: 'User', id: input.userId },
        before: { role: input.role, present: true },
        after: { role: input.role, present: false },
      })
      return { ok: true, alreadyAbsent: false }
    }),

  /* ------------------------------------------------------------------ */
  /* deactivate                                                          */
  /* ------------------------------------------------------------------ */
  deactivate: auditedProcedure
    .input(z.object({ userId: z.string().min(1), reason: z.string().trim().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanDeactivate(actor)
      if (actor.id === input.userId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Cannot deactivate yourself.' })
      }
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: {
          id: true,
          deactivatedAt: true,
          roleAssignments: { select: { id: true, role: true } },
        },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (user.deactivatedAt) {
        return { ok: true, alreadyDeactivated: true }
      }

      for (const ra of user.roleAssignments) {
        const canonical = normaliseRole(ra.role) ?? ('virtual_assistant' as Role)
        if (!canRevokeRole(actor.role, canonical)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `cannot deactivate user with role: ${ra.role}`,
          })
        }
      }

      if (user.roleAssignments.some((r) => r.role === 'ceo' || r.role === 'super_admin')) {
        try {
          await assertNotLastCeo(ctx.db, user.id)
        } catch (e) {
          if (e instanceof BusinessError && e.code === 'LAST_CEO') {
            throw new TRPCError({ code: 'CONFLICT', message: 'cannot deactivate the last ceo' })
          }
          throw e
        }
      }

      const now = new Date()
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          deactivatedAt: now,
          deactivationReason: input.reason,
          isActive: false,
          updatedById: actor.id,
        },
      })
      await ctx.db.roleAssignment.deleteMany({ where: { userId: user.id } })
      await ctx.db.session.deleteMany({ where: { userId: user.id } })

      await ctx.audit({
        action: 'auth.user_deactivated',
        target: { type: 'User', id: user.id },
        after: { reason: input.reason },
      })
      return { ok: true, alreadyDeactivated: false }
    }),

  /* ------------------------------------------------------------------ */
  /* reactivate                                                          */
  /* ------------------------------------------------------------------ */
  reactivate: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanDeactivate(actor)
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, deactivatedAt: true },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (!user.deactivatedAt) {
        return { ok: true, alreadyActive: true }
      }
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          deactivatedAt: null,
          deactivationReason: null,
          isActive: true,
          updatedById: actor.id,
        },
      })
      await ctx.audit({
        action: 'auth.user_reactivated',
        target: { type: 'User', id: user.id },
      })
      return { ok: true, alreadyActive: false }
    }),

  /* ------------------------------------------------------------------ */
  /* delete — soft-remove from the roster (reversible via restore)       */
  /* ------------------------------------------------------------------ */
  // A step beyond deactivate: the account is hidden from the roster, all
  // roles/permissions are stripped, sessions killed, and sign-in blocked. Fully
  // reversible from the Deleted view. CEO + Senior Manager only. GDPR erasure
  // (irreversible anonymisation) is a separate action below.
  delete: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanDeactivate(actor)
      if (actor.id === input.userId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Cannot delete your own account.' })
      }
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, roleAssignments: { select: { role: true } } },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      // Same leadership guards as deactivate.
      for (const ra of user.roleAssignments) {
        const canonical = normaliseRole(ra.role) ?? ('virtual_assistant' as Role)
        if (!canRevokeRole(actor.role, canonical)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: `cannot delete a user with role: ${ra.role}` })
        }
      }
      if (user.roleAssignments.some((r) => r.role === 'ceo' || r.role === 'super_admin')) {
        try {
          await assertNotLastCeo(ctx.db, user.id)
        } catch (e) {
          if (e instanceof BusinessError && e.code === 'LAST_CEO') {
            throw new TRPCError({ code: 'CONFLICT', message: 'cannot delete the last ceo' })
          }
          throw e
        }
      }
      const now = new Date()
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          deletedAt: now,
          deactivatedAt: now,
          deactivationReason: 'Account deleted',
          isActive: false,
          updatedById: actor.id,
        },
      })
      await ctx.db.roleAssignment.deleteMany({ where: { userId: user.id } })
      await ctx.db.userPermission.deleteMany({ where: { userId: user.id } })
      await ctx.db.userCustomRole.deleteMany({ where: { userId: user.id } })
      await ctx.db.session.deleteMany({ where: { userId: user.id } })
      await ctx.audit({ action: 'auth.user_deleted', target: { type: 'User', id: user.id } })
      return { ok: true }
    }),

  /* ------------------------------------------------------------------ */
  /* restore — bring a soft-deleted account back (as deactivated)        */
  /* ------------------------------------------------------------------ */
  restore: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanDeactivate(actor)
      const user = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: { not: null } },
        select: { id: true, email: true },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      // Refuse to un-delete onto a live account that now owns the email.
      const clash = await ctx.db.user.findFirst({
        where: { email: user.email, deletedAt: null, id: { not: user.id } },
        select: { id: true },
      })
      if (clash) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Another live account now uses that email.' })
      }
      // Restore into the DEACTIVATED state (roles were removed on delete). The
      // admin then explicitly reactivates + re-assigns roles — a restored
      // account is never silently active with no roles.
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          deletedAt: null,
          deactivatedAt: new Date(),
          deactivationReason: 'Restored — reactivate and assign roles',
          isActive: false,
          updatedById: actor.id,
        },
      })
      await ctx.audit({ action: 'auth.user_restored', target: { type: 'User', id: user.id } })
      return { ok: true }
    }),

  /* ------------------------------------------------------------------ */
  /* erase — GDPR right-to-erasure: anonymise in place (irreversible)    */
  /* ------------------------------------------------------------------ */
  // Removes all personal data from the account while KEEPING the row, so audit
  // history and every `createdById`/`actorId` reference across the CRM stay
  // resolvable (a hard DELETE would orphan them, §21). CEO only; the actor must
  // retype the email to confirm.
  erase: auditedProcedure
    .input(z.object({ userId: z.string().min(1), confirmEmail: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (actor.role !== 'ceo') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a CEO can permanently erase an account.' })
      }
      if (actor.id === input.userId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Cannot erase your own account.' })
      }
      const user = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          email: true,
          totpSecretCipherId: true,
          mfaSecretCipherId: true,
          gmailRefreshTokenCipherId: true,
          roleAssignments: { select: { role: true } },
        },
      })
      if (!user) throw new TRPCError({ code: 'NOT_FOUND' })
      if (input.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Type the account email exactly to confirm erasure.' })
      }
      if (user.roleAssignments.some((r) => r.role === 'ceo' || r.role === 'super_admin')) {
        try {
          await assertNotLastCeo(ctx.db, user.id)
        } catch (e) {
          if (e instanceof BusinessError && e.code === 'LAST_CEO') {
            throw new TRPCError({ code: 'CONFLICT', message: 'cannot erase the last ceo' })
          }
          throw e
        }
      }
      const now = new Date()
      // Anonymise: tombstone the unique email, drop every PII / secret column.
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          email: `erased-${user.id}@erased.invalid`,
          name: null,
          avatarKey: null,
          passwordHash: null,
          lastSignInIp: null,
          lastSignInUa: null,
          mfaEnabled: false,
          mfaSecretCipherId: null,
          totpSecretCipherId: null,
          totpEnabledAt: null,
          gmailRefreshTokenCipherId: null,
          gmailConnectionStatus: null,
          trengoUserId: null,
          deactivatedAt: now,
          deactivationReason: 'Erased (GDPR right to erasure)',
          isActive: false,
          deletedAt: now,
          updatedById: actor.id,
        },
      })
      // Crypto-shred the KMS envelopes (they aren't FK-enforced, so delete them).
      const cipherIds = [user.totpSecretCipherId, user.mfaSecretCipherId, user.gmailRefreshTokenCipherId].filter(
        (id): id is string => Boolean(id),
      )
      if (cipherIds.length > 0) {
        await ctx.db.encryptedField.deleteMany({ where: { id: { in: cipherIds } } })
      }
      await ctx.db.roleAssignment.deleteMany({ where: { userId: user.id } })
      await ctx.db.userPermission.deleteMany({ where: { userId: user.id } })
      await ctx.db.userCustomRole.deleteMany({ where: { userId: user.id } })
      await ctx.db.session.deleteMany({ where: { userId: user.id } })
      await ctx.db.emailVerificationToken.deleteMany({ where: { userId: user.id } })
      await ctx.db.passwordResetToken.deleteMany({ where: { userId: user.id } })
      await ctx.db.totpRecoveryCode.deleteMany({ where: { userId: user.id } })
      // Never log the erased PII.
      await ctx.audit({ action: 'auth.user_erased', target: { type: 'User', id: user.id }, after: { erased: true } })
      return { ok: true }
    }),

  /* ------------------------------------------------------------------ */
  /* forceSignOut — revoke all of a user's sessions                      */
  /* ------------------------------------------------------------------ */
  forceSignOut: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManage(actor, await loadActorGrants(ctx.db, actor.id))
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, roleAssignments: { select: { role: true } } },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })
      assertCanActOnTarget(actor, target.roleAssignments.map((r) => r.role))
      const { count } = await ctx.db.session.deleteMany({ where: { userId: target.id } })
      await ctx.audit({
        action: 'auth.sessions_revoked_by_admin',
        target: { type: 'User', id: target.id },
        after: { count },
      })
      return { ok: true, count }
    }),

  /* ------------------------------------------------------------------ */
  /* sendLoginReminder — nudge a user who has never signed in            */
  /* ------------------------------------------------------------------ */
  sendLoginReminder: auditedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManage(actor, await loadActorGrants(ctx.db, actor.id))
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null, deactivatedAt: null },
        select: { id: true, email: true, name: true, lastSignInAt: true },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })
      if (target.lastSignInAt) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This user has already signed in.' })
      }
      const rendered = buildLoginReminderEmail({ name: target.name, signInUrl: `${appUrl()}/sign-in` })
      const send = await sendSystemEmail({ to: target.email, subject: rendered.subject, text: rendered.text, html: rendered.html })
      if (send.status === 'failed') {
        logger.error({ detail: send.detail }, 'admin.users.login_reminder.email_send_failed')
      }
      await ctx.db.user.update({
        where: { id: target.id },
        data: { lastLoginReminderAt: new Date(), loginReminderCount: { increment: 1 } },
      })
      await ctx.audit({
        action: 'auth.login_reminder_sent',
        target: { type: 'User', id: target.id },
        after: { emailStatus: send.status, manual: true },
      })
      return { ok: true, emailStatus: send.status }
    }),

  /* ------------------------------------------------------------------ */
  /* permissionsFor / setPermissions — individual permission grants      */
  /* ------------------------------------------------------------------ */
  // Give an individual specific capabilities on top of their role, using the
  // same safe set + no-escalation guard as custom roles (§20). CEO + Senior
  // Manager grant these.
  permissionsFor: protectedProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (actor.role !== 'ceo' && actor.role !== 'senior_manager') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a CEO or Senior Manager can view individual permissions.' })
      }
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, roleAssignments: { select: { role: true } }, permissions: { select: { permission: true } } },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })
      const targetRole = pickPrimaryRole(target.roleAssignments.map((r) => r.role))
      const individual = target.permissions.map((p) => p.permission).filter(isAssignableAction)
      const targetEffective = await loadEffectiveGrants(ctx.db, target.id)
      // From base role (read-only in the UI).
      const roleActions = ASSIGNABLE_ACTIONS.filter((a) => roleCan(targetRole, a))
      // From custom roles = effective minus role minus individual grants.
      const customRoleActions = targetEffective.filter(
        (a) => isAssignableAction(a) && !individual.includes(a as Action) && !roleActions.includes(a as Action),
      )
      // What THIS actor may grant (their own effective actions, assignable only).
      const actorGrants = await loadActorGrants(ctx.db, actor.id)
      const actorCanGrant = ASSIGNABLE_ACTIONS.filter((a) => hasAction(actor.role, actorGrants, a))
      return {
        catalogue: ACTION_GROUPS.map((g) => ({
          title: g.label,
          actions: g.actions
            .filter((a) => isAssignableAction(a))
            .map((a) => ({ action: a, label: ACTION_LABELS[a] })),
        })).filter((g) => g.actions.length > 0),
        roleActions,
        customRoleActions,
        individual,
        actorCanGrant,
      }
    }),

  setPermissions: auditedProcedure
    .input(z.object({ userId: z.string().min(1), permissions: z.array(z.string()).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (actor.role !== 'ceo' && actor.role !== 'senior_manager') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only a CEO or Senior Manager can grant individual permissions.' })
      }
      const target = await ctx.db.user.findFirst({
        where: { id: input.userId, deletedAt: null },
        select: { id: true, roleAssignments: { select: { role: true } }, permissions: { select: { id: true, permission: true } } },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })
      assertCanActOnTarget(actor, target.roleAssignments.map((r) => r.role))
      // No privilege escalation: the actor may only grant what they hold.
      const actorGrants = await loadActorGrants(ctx.db, actor.id)
      const actorEffective = ACTIONS.filter((a) => hasAction(actor.role, actorGrants, a))
      const desired = new Set(sanitizeRolePermissions(actorEffective, input.permissions))
      // Reconcile the user's individual (assignable) permission rows to `desired`.
      // Rows the actor cannot grant are left untouched (they didn't ask to change them).
      const existingAssignable = target.permissions.filter((p) => isAssignableAction(p.permission))
      const existingSet = new Set(existingAssignable.map((p) => p.permission))
      const canGrant = new Set(actorEffective.filter(isAssignableAction))
      const toAdd = [...desired].filter((p) => !existingSet.has(p))
      const toRemove = existingAssignable.filter((p) => !desired.has(p.permission as Action) && canGrant.has(p.permission as Action))
      for (const p of toAdd) {
        await ctx.db.userPermission.create({
          data: { id: createId(), userId: target.id, permission: p, createdById: actor.id },
        })
      }
      for (const p of toRemove) {
        await ctx.db.userPermission.delete({ where: { id: p.id } })
      }
      await ctx.audit({
        action: 'auth.user_permissions_set',
        target: { type: 'User', id: target.id },
        after: { added: toAdd, removed: toRemove.map((p) => p.permission) },
      })
      return { ok: true, added: toAdd.length, removed: toRemove.length }
    }),
})
