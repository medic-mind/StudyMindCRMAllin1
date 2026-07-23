// Dashboard "Needs attention" queues — pure assembly logic (CLAUDE.md §26
// view-model boundary, §20 role gating). The router gathers raw counts; this
// module turns them into role-filtered, tone-coded, urgency-sorted cards the
// home page renders. Kept pure (no I/O, no React) so the decision logic is
// unit-tested in isolation.

import type { UserRole } from '@/lib/trpc/builders'

export type QueueTone = 'info' | 'warn' | 'danger' | 'success'

/** Icon keys the dashboard maps to a Lucide-style component. Keeping them as
 * strings keeps the tRPC payload serialisable (no React on the wire). */
export type QueueIconKey =
  | 'phone'
  | 'userPlus'
  | 'alertTriangle'
  | 'hash'
  | 'coins'
  | 'repeat'

export interface QueueCard {
  key: string
  label: string
  count: number
  href: string
  tone: QueueTone
  icon: QueueIconKey
}

/** Raw counts gathered by the dashboard router — numbers only, never UI. */
export interface QueueCounts {
  missedCalls: number
  leadsToTriage: number
  openComplaints: number
  slackMentions: number
  directDebitIssues: number
}

const FINANCE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

interface QueueDef {
  key: keyof QueueCounts
  label: string
  href: string
  icon: QueueIconKey
  /** Tone to use when the count is > 0; an empty queue always renders calm. */
  activeTone: Exclude<QueueTone, 'success'>
  /** Roles allowed to see this queue. Omit = every staff role. */
  roles?: ReadonlySet<UserRole>
}

// Order here is the tie-breaker when two queues have the same count, so a
// stable, sensible layout survives identical counts (e.g. all zero).
const QUEUE_DEFS: readonly QueueDef[] = [
  { key: 'missedCalls', label: 'Missed calls', href: '/calls', icon: 'phone', activeTone: 'warn' },
  { key: 'leadsToTriage', label: 'Leads to triage', href: '/leads', icon: 'userPlus', activeTone: 'warn' },
  { key: 'openComplaints', label: 'Open complaints', href: '/complaints', icon: 'alertTriangle', activeTone: 'danger' },
  { key: 'slackMentions', label: 'Slack mentions', href: '/inbox/slack-mentions', icon: 'hash', activeTone: 'info' },
  // Finance-reconciliation + unresolved-payment queues removed with the Stripe
  // finance surface (2026-07). Direct Debit issues is the live money queue.
  { key: 'directDebitIssues', label: 'Direct Debit issues', href: '/direct-debits/issues', icon: 'repeat', activeTone: 'danger', roles: FINANCE_ROLES },
]

/**
 * Build the role-filtered queue cards, most-pressing first. An empty queue is
 * a reassuring "all clear" (success tone) and sinks to the bottom; non-empty
 * queues sort by count descending so the biggest backlog is the first thing
 * the agent sees.
 */
export function buildQueueCards(counts: QueueCounts, role: UserRole): QueueCard[] {
  return QUEUE_DEFS.filter((d) => !d.roles || d.roles.has(role))
    .map((d, i) => {
      const count = Math.max(0, counts[d.key] ?? 0)
      const card: QueueCard = {
        key: d.key,
        label: d.label,
        count,
        href: d.href,
        tone: count > 0 ? d.activeTone : 'success',
        icon: d.icon,
      }
      return { card, i }
    })
    .sort((a, b) => b.card.count - a.card.count || a.i - b.i)
    .map(({ card }) => card)
}
