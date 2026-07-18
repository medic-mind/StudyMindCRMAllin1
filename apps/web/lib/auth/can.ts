// Effective permission check for a request. Returns true if the actor's base
// role grants `action` OR they hold it via a custom role / per-user grant
// (§20). Role-granted actions short-circuit with no DB read; only actions the
// base role lacks trigger a single grant load. Always false for an
// unauthenticated caller.
//
// Prefer this over ad-hoc `ROLE_SET.has(ctx.user.role)` checks when a gate
// corresponds to a real ACTION — it is what makes custom roles take effect.
// Catastrophic (deny-list) actions are never assignable, so they can only ever
// be satisfied by the base role.

import { TRPCError } from '@trpc/server'

import { type Action, roleCan } from '@studymind/core/auth/policies'
import type { PrismaClient } from '@studymind/db'

import type { SessionUser } from '@/lib/trpc/builders'

import { loadEffectiveGrants } from './effective-grants'

interface CanCtx {
  user: SessionUser | null
  db: Pick<PrismaClient, 'userPermission' | 'userCustomRole'>
}

export async function can(ctx: CanCtx, action: Action): Promise<boolean> {
  const user = ctx.user
  if (!user) return false
  if (roleCan(user.role, action)) return true
  const grants = await loadEffectiveGrants(ctx.db, user.id)
  return grants.includes(action)
}

/** Throwing variant for gate sites: pass a friendly FORBIDDEN message. */
export async function assertCan(ctx: CanCtx, action: Action, message: string): Promise<void> {
  if (!(await can(ctx, action))) {
    throw new TRPCError({ code: 'FORBIDDEN', message })
  }
}
