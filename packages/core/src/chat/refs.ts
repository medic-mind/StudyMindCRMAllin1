// Resolve inline CRM-entity references in chat messages to display labels +
// in-app hrefs, and power the composer's reference picker (ADR 0022).
//
// References are stored as ChatMessageRef rows AND inline tokens in the body
// (see parse.ts). This module is the read side: given a set of (type,id) refs
// it returns a label + href for each, batched per entity type so a message
// list resolves all of its chips in a handful of queries.

import { displayNameOf } from '../contact/types'
import type { Db } from './ctx'
import type { ParsedRef } from './parse'
import type { ChatRefView } from './types'

function refKey(type: string, id: string): string {
  return `${type}:${id}`
}

/**
 * Resolve a batch of refs to view-models keyed by `${type}:${id}`. Unknown or
 * deleted entities resolve to a label with a null href so the chip renders
 * (greyed) rather than vanishing — the message history stays faithful.
 */
export async function resolveRefs(
  db: Db,
  refs: ReadonlyArray<ParsedRef>,
): Promise<Map<string, ChatRefView>> {
  const out = new Map<string, ChatRefView>()
  if (refs.length === 0) return out

  const byType = {
    contact: new Set<string>(),
    family: new Set<string>(),
    card: new Set<string>(),
    task: new Set<string>(),
  }
  for (const r of refs) byType[r.type].add(r.id)

  // Default every requested ref to "not found" so callers always get an entry.
  for (const r of refs) {
    out.set(refKey(r.type, r.id), {
      type: r.type,
      id: r.id,
      label: r.type === 'family' ? 'Family' : r.type,
      href: null,
    })
  }

  const [contacts, families, cards, tasks] = await Promise.all([
    byType.contact.size
      ? db.contact.findMany({
          where: { id: { in: [...byType.contact] } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phoneE164: true,
            deletedAt: true,
          },
        })
      : Promise.resolve([]),
    byType.family.size
      ? db.family.findMany({
          where: { id: { in: [...byType.family] } },
          select: { id: true, name: true, deletedAt: true },
        })
      : Promise.resolve([]),
    byType.card.size
      ? db.card.findMany({
          where: { id: { in: [...byType.card] } },
          select: {
            id: true,
            boardId: true,
            description: true,
            contact: {
              select: {
                firstName: true,
                lastName: true,
                email: true,
                phoneE164: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    byType.task.size
      ? db.task.findMany({
          where: { id: { in: [...byType.task] } },
          select: { id: true, title: true, deletedAt: true },
        })
      : Promise.resolve([]),
  ])

  for (const c of contacts) {
    out.set(refKey('contact', c.id), {
      type: 'contact',
      id: c.id,
      label: displayNameOf(c),
      href: c.deletedAt ? null : `/contacts/${c.id}`,
    })
  }
  for (const f of families) {
    out.set(refKey('family', f.id), {
      type: 'family',
      id: f.id,
      label: f.name ?? `Family ${f.id.slice(-6)}`,
      href: f.deletedAt ? null : `/contacts/families/${f.id}`,
    })
  }
  for (const c of cards) {
    const name = c.contact ? displayNameOf(c.contact) : 'Card'
    out.set(refKey('card', c.id), {
      type: 'card',
      id: c.id,
      label: c.description?.trim() ? `${c.description.trim()} · ${name}` : name,
      href: `/boards/${c.boardId}?card=${c.id}`,
    })
  }
  for (const t of tasks) {
    out.set(refKey('task', t.id), {
      type: 'task',
      id: t.id,
      label: t.title,
      href: t.deletedAt ? null : `/tasks/${t.id}`,
    })
  }

  return out
}

export interface RefSearchResult {
  type: ParsedRef['type']
  id: string
  label: string
  sublabel: string | null
}

/**
 * Search CRM entities for the composer's "reference a customer" picker. Mixed
 * result set across Contacts, Families, Cards, and Tasks, ranked by type then
 * name. Read-only; never mutates.
 */
export async function searchRefTargets(
  db: Db,
  input: { query: string; limit?: number },
): Promise<RefSearchResult[]> {
  const q = input.query.trim()
  if (q.length === 0) return []
  const perType = Math.max(1, Math.min(input.limit ?? 6, 10))

  const [contacts, families, cards, tasks] = await Promise.all([
    db.contact.findMany({
      where: {
        deletedAt: null,
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: perType,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneE164: true,
      },
    }),
    db.family.findMany({
      where: { deletedAt: null, name: { contains: q, mode: 'insensitive' } },
      take: perType,
      select: { id: true, name: true },
    }),
    db.card.findMany({
      where: {
        archivedAt: null,
        description: { contains: q, mode: 'insensitive' },
      },
      take: perType,
      select: {
        id: true,
        description: true,
        contact: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            phoneE164: true,
          },
        },
      },
    }),
    db.task.findMany({
      where: { deletedAt: null, title: { contains: q, mode: 'insensitive' } },
      take: perType,
      select: { id: true, title: true },
    }),
  ])

  const results: RefSearchResult[] = []
  for (const c of contacts) {
    results.push({ type: 'contact', id: c.id, label: displayNameOf(c), sublabel: c.email ?? null })
  }
  for (const f of families) {
    results.push({
      type: 'family',
      id: f.id,
      label: f.name ?? `Family ${f.id.slice(-6)}`,
      sublabel: 'Family',
    })
  }
  for (const c of cards) {
    const name = c.contact ? displayNameOf(c.contact) : 'Card'
    results.push({
      type: 'card',
      id: c.id,
      label: c.description?.trim() || name,
      sublabel: `Card · ${name}`,
    })
  }
  for (const t of tasks) {
    results.push({ type: 'task', id: t.id, label: t.title, sublabel: 'Task' })
  }
  return results
}
