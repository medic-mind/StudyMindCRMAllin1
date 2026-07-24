// Audit viewer router (CLAUDE.md §20, §27, §45). Surfaces the append-only
// AuditLogEntry table so a human can finally see "who did what, and when" —
// both per record (`forTarget`, rendered as the contact-page Activity log)
// and org-wide (`list`, the Settings → Audit log page). Reads are gated on
// the `audit.read` action (CEO / Senior Manager / Manager, plus any custom
// role granted it), enforced server-side via assertCan.
//
// `recordExport` closes the "bulk CSV export leaves no trace" gap: the export
// button now tells the server an export happened, and it lands in the same
// audit stream as every other action.

import { z } from 'zod'

import { assertCan } from '@/lib/auth/can'
import { auditedProcedure, protectedProcedure, requireUser, router } from '@/lib/trpc/builders'
import { toAuditActivityRow, type AuditActor } from '@/lib/view-models/audit-activity'

const CursorSchema = z.object({ occurredAt: z.date(), id: z.string() })

const SELECT = {
  id: true,
  action: true,
  actorId: true,
  targetType: true,
  targetId: true,
  purpose: true,
  before: true,
  after: true,
  occurredAt: true,
} as const

interface RawRow {
  id: string
  action: string
  actorId: string | null
  targetType: string
  targetId: string
  purpose: string | null
  before: unknown
  after: unknown
  occurredAt: Date
}

type DbLike = {
  auditLogEntry: { findMany: (args: unknown) => Promise<RawRow[]> }
  user: {
    findMany: (args: unknown) => Promise<Array<{ id: string; name: string | null; email: string | null }>>
  }
  contact: {
    findMany: (args: unknown) => Promise<
      Array<{ id: string; firstName: string | null; lastName: string | null; email: string | null }>
    >
  }
}

async function resolveActors(
  db: DbLike,
  rows: readonly RawRow[],
): Promise<Map<string, AuditActor>> {
  const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => Boolean(x)))]
  if (ids.length === 0) return new Map()
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  })
  return new Map(users.map((u) => [u.id, { name: u.name, email: u.email }]))
}

/** Best-effort human label for a Contact target (the dominant target type). */
async function resolveContactTargets(
  db: DbLike,
  rows: readonly RawRow[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.filter((r) => r.targetType === 'Contact').map((r) => r.targetId)),
  ]
  if (ids.length === 0) return new Map()
  const contacts = await db.contact.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, email: true },
  })
  return new Map(
    contacts.map((c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
      return [c.id, name || c.email || 'Contact']
    }),
  )
}

function keysetWhere(cursor: z.infer<typeof CursorSchema> | null | undefined) {
  if (!cursor) return {}
  return {
    OR: [
      { occurredAt: { lt: cursor.occurredAt } },
      { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
    ],
  }
}

export const auditRouter = router({
  // Per-record activity: everything that has happened to one entity, newest
  // first. Powers the contact-page "Activity log" section.
  forTarget: protectedProcedure
    .input(
      z.object({
        targetType: z.string().default('Contact'),
        targetId: z.string().min(1),
        cursor: CursorSchema.nullish(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertCan(ctx, 'audit.read', 'You do not have permission to view the activity log.')
      const db = ctx.db as unknown as DbLike
      const rows = await db.auditLogEntry.findMany({
        where: {
          targetType: input.targetType,
          targetId: input.targetId,
          ...keysetWhere(input.cursor),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: SELECT,
      })
      const hasMore = rows.length > input.limit
      const page = hasMore ? rows.slice(0, input.limit) : rows
      const actors = await resolveActors(db, page)
      const last = page.at(-1)
      return {
        items: page.map((r) => toAuditActivityRow(r, actors)),
        nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
      }
    }),

  // Org-wide audit search: who did what across the whole CRM, filterable by
  // person, action set, target type, and date range.
  list: protectedProcedure
    .input(
      z.object({
        actorId: z.string().optional(),
        actions: z.array(z.string()).max(50).optional(),
        targetType: z.string().optional(),
        since: z.date().optional(),
        until: z.date().optional(),
        cursor: CursorSchema.nullish(),
        limit: z.number().int().min(1).max(100).default(40),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertCan(ctx, 'audit.read', 'You do not have permission to view the audit log.')
      const db = ctx.db as unknown as DbLike
      const occurredAt =
        input.since || input.until
          ? { ...(input.since ? { gte: input.since } : {}), ...(input.until ? { lte: input.until } : {}) }
          : undefined
      const rows = await db.auditLogEntry.findMany({
        where: {
          ...(input.actorId ? { actorId: input.actorId } : {}),
          ...(input.actions && input.actions.length ? { action: { in: input.actions } } : {}),
          ...(input.targetType ? { targetType: input.targetType } : {}),
          ...(occurredAt ? { occurredAt } : {}),
          ...keysetWhere(input.cursor),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: SELECT,
      })
      const hasMore = rows.length > input.limit
      const page = hasMore ? rows.slice(0, input.limit) : rows
      const [actors, contactTargets] = await Promise.all([
        resolveActors(db, page),
        resolveContactTargets(db, page),
      ])
      const last = page.at(-1)
      return {
        items: page.map((r) => ({
          ...toAuditActivityRow(r, actors),
          targetType: r.targetType,
          targetId: r.targetId,
          targetLabel: r.targetType === 'Contact' ? (contactTargets.get(r.targetId) ?? null) : null,
        })),
        nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
      }
    }),

  // Records that a bulk CSV export happened (who, which list, how many rows,
  // what filter). Called by the Export CSV button so exports are no longer
  // invisible. Any staff member who can see a list can export it (§20.1
  // contact.read), so this is intentionally not role-gated beyond auth — the
  // point is the trail, not a new restriction.
  recordExport: auditedProcedure
    .input(
      z.object({
        kind: z.enum(['contact', 'account']),
        rowCount: z.number().int().min(0),
        filterSummary: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      await ctx.audit({
        action: input.kind === 'contact' ? 'contact.exported' : 'account.exported',
        target: { type: 'Export', id: user.id },
        after: {
          kind: input.kind,
          rowCount: input.rowCount,
          filter: input.filterSummary ?? null,
        },
      })
      return { ok: true as const }
    }),
})
