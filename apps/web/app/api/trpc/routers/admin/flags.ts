// Admin → Feature flags router. CLAUDE.md §31, §27.
//
// Reads the registry + DB row to surface effective values to the settings UI.
// `setFlag` delegates to packages/core/src/flags/admin.ts which audits in tx.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { FLAGS, isFlagName, type FlagName } from '@studymind/core/flags/registry'
import { setFlag } from '@studymind/core/flags/admin'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

// Feature flags are admin-tier (ADR 0014).
const READ_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
])

function envKey(name: FlagName): string {
  return 'FLAG_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

function readEnvOverride(name: FlagName): boolean | null {
  const raw = process.env[envKey(name)]
  if (raw === undefined) return null
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return null
}

const STALE_AGE_DAYS = 30

export const adminFlagsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    if (!READ_ROLES.has(user.role)) {
      throw new TRPCError({ code: 'FORBIDDEN' })
    }

    const rows = await ctx.db.featureFlag.findMany({
      select: { key: true, enabled: true, createdAt: true, updatedAt: true },
    })
    const byKey = new Map(rows.map((r) => [r.key, r]))

    const now = Date.now()
    const items = (Object.keys(FLAGS) as FlagName[]).map((name) => {
      const meta = FLAGS[name]
      const row = byKey.get(name)
      const env = readEnvOverride(name)
      const dbValue = row?.enabled ?? null
      const effective =
        env !== null ? env : dbValue !== null ? dbValue : meta.default
      const source: 'env' | 'db' | 'default' =
        env !== null ? 'env' : dbValue !== null ? 'db' : 'default'
      const ageDays = row
        ? Math.floor((now - row.createdAt.getTime()) / (1000 * 60 * 60 * 24))
        : null
      const stale = meta.kind === 'release' && ageDays !== null && ageDays > STALE_AGE_DAYS
      return {
        name,
        kind: meta.kind,
        description: meta.description,
        owner: meta.owner,
        default: meta.default,
        effective,
        source,
        envKey: envKey(name),
        ageDays,
        stale,
      }
    })

    return { items }
  }),

  setFlag: auditedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        enabled: z.boolean(),
        reason: z.string().trim().min(3),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = requireUser(ctx)
      if (!READ_ROLES.has(actor.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      if (!isFlagName(input.name)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'unknown flag' })
      }
      // setFlag writes its own audit inside withAudit; call ctx.audit too so
      // the auditedProcedure runtime check does not fail (CLAUDE.md §27).
      const res = await setFlag(ctx.db, {
        name: input.name,
        enabled: input.enabled,
        actorId: actor.id,
        reason: input.reason,
        requestId: ctx.requestId,
      })
      await ctx.audit({
        action: 'flag.toggled.acked',
        target: { type: 'FeatureFlag', id: input.name },
        before: { enabled: res.before },
        after: { enabled: res.after, reason: input.reason },
      })
      return res
    }),
})
