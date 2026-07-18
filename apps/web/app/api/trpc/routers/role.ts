// Custom roles tRPC router (§20 follow-on). Operator-managed, additive
// permission bundles layered on the fixed built-in roles.
//
// Safety guarantees (enforced here + in `sanitizeRolePermissions`):
//  - Only ASSIGNABLE_ACTIONS can go into a role (catastrophic actions never).
//  - No privilege escalation: an actor can only put a permission they THEMSELVES
//    hold into a role, and can only assign roles whose permissions they hold.
//  - Built-in roles are immutable and shown read-only (the matrix).
// Management (create/edit/archive/assign) is CEO + Senior Manager, mirroring
// Teams; reads are open to any user who can manage users.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ACTION_GROUPS,
  ACTION_LABELS,
  ACTIONS,
  ASSIGNABLE_ACTIONS,
  ROLES,
  roleCan,
  sanitizeRolePermissions,
} from '@studymind/core/auth/policies'

import { formatRoleLabel } from '@/lib/format/role-label'
import { loadEffectiveGrants } from '@/lib/auth/effective-grants'
import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const ROLE_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['ceo', 'senior_manager'])

function assertCanManageRoles(role: UserRole): void {
  if (!ROLE_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only a CEO or Senior Manager can manage roles.',
    })
  }
}

/** The set of actions the actor themselves can perform (base role ∪ grants). */
async function actorEffectiveActions(
  db: Parameters<typeof loadEffectiveGrants>[0],
  actorId: string,
  role: UserRole,
): Promise<string[]> {
  const granted = await loadEffectiveGrants(db, actorId)
  return ACTIONS.filter((a) => roleCan(role, a) || granted.includes(a))
}

const NameSchema = z
  .string()
  .trim()
  .min(2, 'Give the role a name')
  .max(60, 'Keep the name under 60 characters')
const ColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour')
  .default('#2563eb')
const PermsSchema = z.array(z.string()).max(ACTIONS.length)

export const roleRouter = router({
  /** Capability flags for the RSC page gate. */
  myAccess: protectedProcedure.query(({ ctx }) => {
    const actor = requireUser(ctx)
    return { canManage: ROLE_MANAGE_ROLES.has(actor.role) }
  }),

  /** The permission catalogue (grouped) + which the actor may assign. */
  permissionCatalogue: protectedProcedure.query(async ({ ctx }) => {
    const actor = requireUser(ctx)
    const effective = new Set(await actorEffectiveActions(ctx.db, actor.id, actor.role))
    return {
      groups: ACTION_GROUPS.map((g) => ({
        label: g.label,
        actions: g.actions.map((a) => ({
          action: a,
          label: ACTION_LABELS[a],
          assignable: (ASSIGNABLE_ACTIONS as readonly string[]).includes(a),
          // The actor can only hand out a permission they hold (no escalation).
          canAssign: (ASSIGNABLE_ACTIONS as readonly string[]).includes(a) && effective.has(a),
        })),
      })),
    }
  }),

  /** Built-in role → action matrix (read-only reference). */
  matrix: protectedProcedure.query(() => {
    return {
      roles: ROLES.map((r) => ({ role: r, label: formatRoleLabel(r) })),
      groups: ACTION_GROUPS.map((g) => ({
        label: g.label,
        actions: g.actions.map((a) => ({
          action: a,
          label: ACTION_LABELS[a],
          grants: ROLES.map((r) => roleCan(r, a)),
        })),
      })),
    }
  }),

  /** List custom roles with member counts. */
  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).default({ includeArchived: false }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.customRole.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { members: true } } },
      })
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        color: r.color,
        permissions: r.permissions,
        memberCount: r._count.members,
        archived: r.archivedAt != null,
      }))
    }),

  /** Users assigned to a role, plus who else could be assigned. */
  members: protectedProcedure
    .input(z.object({ customRoleId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.userCustomRole.findMany({
        where: { customRoleId: input.customRoleId },
        select: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { user: { email: 'asc' } },
      })
      return rows.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email }))
    }),

  /** A small user directory for the assignment picker (active users). */
  assignableUsers: protectedProcedure
    .input(z.object({ q: z.string().trim().max(120).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const q = input.q?.toLowerCase()
      const rows = await ctx.db.user.findMany({
        where: {
          deactivatedAt: null,
          ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {}),
        },
        select: { id: true, name: true, email: true },
        orderBy: { email: 'asc' },
        take: 25,
      })
      return rows.map((u) => ({ id: u.id, name: u.name, email: u.email }))
    }),

  create: auditedProcedure
    .input(
      z.object({
        name: NameSchema,
        description: z.string().trim().max(300).optional(),
        color: ColorSchema,
        permissions: PermsSchema.default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManageRoles(actor.role)
      const effective = await actorEffectiveActions(ctx.db, actor.id, actor.role)
      const permissions = sanitizeRolePermissions(effective, input.permissions)
      const id = createId()
      const created = await ctx.db.customRole.create({
        data: {
          id,
          name: input.name,
          description: input.description ?? null,
          color: input.color,
          permissions,
          createdById: actor.id,
          updatedById: actor.id,
        },
      })
      await ctx.audit({
        action: 'role.created',
        target: { type: 'CustomRole', id: created.id },
        after: { name: created.name, permissions },
      })
      return { id: created.id }
    }),

  update: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        name: NameSchema.optional(),
        description: z.string().trim().max(300).nullable().optional(),
        color: ColorSchema.optional(),
        permissions: PermsSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManageRoles(actor.role)
      const existing = await ctx.db.customRole.findUnique({ where: { id: input.id } })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found.' })

      const data: Record<string, unknown> = { updatedById: actor.id }
      if (input.name !== undefined) data['name'] = input.name
      if (input.description !== undefined) data['description'] = input.description
      if (input.color !== undefined) data['color'] = input.color
      if (input.permissions !== undefined) {
        const effective = await actorEffectiveActions(ctx.db, actor.id, actor.role)
        data['permissions'] = sanitizeRolePermissions(effective, input.permissions)
      }
      const updated = await ctx.db.customRole.update({ where: { id: input.id }, data })
      await ctx.audit({
        action: 'role.updated',
        target: { type: 'CustomRole', id: updated.id },
        before: { name: existing.name, permissions: existing.permissions },
        after: { name: updated.name, permissions: updated.permissions },
      })
      return { ok: true }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManageRoles(actor.role)
      await ctx.db.customRole.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: actor.id },
      })
      await ctx.audit({ action: 'role.archived', target: { type: 'CustomRole', id: input.id } })
      return { ok: true }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManageRoles(actor.role)
      await ctx.db.customRole.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: actor.id },
      })
      await ctx.audit({ action: 'role.restored', target: { type: 'CustomRole', id: input.id } })
      return { ok: true }
    }),

  assignToUser: auditedProcedure
    .input(z.object({ customRoleId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManageRoles(actor.role)
      await ctx.db.userCustomRole.upsert({
        where: { userId_customRoleId: { userId: input.userId, customRoleId: input.customRoleId } },
        create: {
          id: createId(),
          userId: input.userId,
          customRoleId: input.customRoleId,
          createdById: actor.id,
        },
        update: {},
      })
      await ctx.audit({
        action: 'role.assigned',
        target: { type: 'User', id: input.userId },
        after: { customRoleId: input.customRoleId },
      })
      return { ok: true }
    }),

  unassignFromUser: auditedProcedure
    .input(z.object({ customRoleId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      assertCanManageRoles(actor.role)
      await ctx.db.userCustomRole.deleteMany({
        where: { userId: input.userId, customRoleId: input.customRoleId },
      })
      await ctx.audit({
        action: 'role.unassigned',
        target: { type: 'User', id: input.userId },
        after: { customRoleId: input.customRoleId },
      })
      return { ok: true }
    }),
})
