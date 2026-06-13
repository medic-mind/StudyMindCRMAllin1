// Trengo team mirror (CLAUDE.md §11). Pulls the workspace's USERS (agents)
// from `GET /users` into the `TrengoUser` table so the CRM reflects the Trengo
// team even for agents who never logged into the CRM — the assignee picker can
// then offer ANY Trengo agent, and assignee/sender names always resolve.
//
// Auto-links each mirrored agent to a CRM `User` by email (and stamps
// `User.trengoUserId` where blank, so the existing per-agent paths keep
// working) — but never auto-merges or overwrites (§3). Idempotent on
// `trengoUserId`; safe to re-run.

import { createId } from '@paralleldrive/cuid2'

import type { PrismaClient } from '@prisma/client'

import { createClientForAgent } from './client'
import { parseListResponse } from './backfill'

interface RawTrengoUser {
  id?: number
  full_name?: string | null
  name?: string | null
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  is_active?: boolean
  status?: string | null
}

/** Fold a raw `/users` row to {id, name, email, active}. Null when no id. */
export function normaliseTrengoUser(
  raw: unknown,
): { trengoUserId: number; name: string | null; email: string | null; isActive: boolean } | null {
  if (raw === null || typeof raw !== 'object') return null
  const u = raw as RawTrengoUser
  if (typeof u.id !== 'number') return null
  const joined = [u.first_name, u.last_name]
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join(' ')
  const name =
    [u.full_name, u.name, joined].find(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    ) ?? null
  const email =
    typeof u.email === 'string' && u.email.trim() !== '' ? u.email.trim().toLowerCase() : null
  // Default active unless the row explicitly says otherwise.
  const isActive =
    u.is_active === false || (typeof u.status === 'string' && u.status.toLowerCase() === 'inactive')
      ? false
      : true
  return { trengoUserId: u.id, name, email, isActive }
}

export interface SyncTeamResult {
  synced: number
  linked: number
}

/**
 * Pull the full Trengo user list (paginated) and upsert the `TrengoUser`
 * mirror, auto-linking to CRM Users by email. Runs through the calling
 * agent's own per-agent token. Returns counts. Throws on a token/API error so
 * the caller can surface it.
 */
export async function syncTrengoTeam(
  db: PrismaClient,
  agentId: string,
  requestId: string,
): Promise<SyncTeamResult> {
  const client = await createClientForAgent({
    agentId,
    requestId,
    purpose: 'trengo.sync_team',
  })

  // Collect every page (bounded — an ops team is small).
  const rows: unknown[] = []
  for (let page = 1; page <= 20; page += 1) {
    const res = await client.request<unknown>('GET', `/users?page=${page}&per_page=200`)
    const parsed = parseListResponse<unknown>(res, page)
    rows.push(...parsed.rows)
    if (!parsed.hasNext) break
  }

  let synced = 0
  let linked = 0
  for (const raw of rows) {
    const u = normaliseTrengoUser(raw)
    if (!u) continue
    // Match a CRM user by email (case-insensitive) for the link.
    const crmUser = u.email
      ? await db.user.findFirst({
          where: { email: { equals: u.email, mode: 'insensitive' }, deletedAt: null },
          select: { id: true, trengoUserId: true },
        })
      : null
    await db.trengoUser.upsert({
      where: { trengoUserId: u.trengoUserId },
      create: {
        id: createId(),
        trengoUserId: u.trengoUserId,
        name: u.name,
        email: u.email,
        isActive: u.isActive,
        crmUserId: crmUser?.id ?? null,
      },
      update: {
        name: u.name,
        email: u.email,
        isActive: u.isActive,
        ...(crmUser ? { crmUserId: crmUser.id } : {}),
      },
    })
    synced += 1
    // Stamp the CRM user's trengoUserId when blank (never overwrite — §3), so
    // the existing per-agent resolution paths keep working.
    if (crmUser && crmUser.trengoUserId === null) {
      try {
        await db.user.update({
          where: { id: crmUser.id },
          data: { trengoUserId: u.trengoUserId },
        })
        linked += 1
      } catch {
        // Another CRM user already holds this trengoUserId (unique) — leave it.
      }
    }
  }
  return { synced, linked }
}
