// Recent activity feed for the dashboard. Renders the last N AuditLogEntry
// rows the caller is allowed to see. RSC — pure presentational.

import Link from 'next/link'

import { formatRelativeTime } from '@/lib/format/relative-time'

export interface ActivityRow {
  id: string
  action: string
  actorEmail: string | null
  targetType: string
  targetId: string
  occurredAt: Date
  href: string | null
}

interface Props {
  rows: ActivityRow[]
  now?: Date
}

function actionLabel(action: string): string {
  // Translate dotted event names into a sentence-cased phrase so the feed
  // reads like prose. CLAUDE.md §45 keeps names machine-friendly; the UI
  // sentence-cases them for humans.
  const known: Record<string, string> = {
    'contact.created': 'created a contact',
    'contact.updated': 'updated a contact',
    'contact.risk_flagged': 'flagged an at-risk customer',
    'contact.risk_dismissed': 'dismissed an at-risk customer',
    'family.merged': 'merged families',
    'family.state_changed': 'changed family state',
    'card.moved': 'moved a card',
    'card_moved': 'moved a card',
    'card.deleted': 'deleted a card',
    'charge.refunded': 'issued a refund',
    'charge.payment_link_requested': 'created a payment link',
    'finance.discrepancy_resolved': 'resolved a discrepancy',
    'finance.unresolved_payment_resolved': 'linked a payment',
    'task.created': 'created a task',
    'task.completed': 'completed a task',
    'complaint.created': 'logged a complaint',
    'complaint.resolved': 'resolved a complaint',
    'business_account.note_added': 'added an account note',
    'mail.composed': 'sent an email',
    'mail.thread_replied': 'replied to an email',
    'reconciliation.discrepancy_resolved': 'resolved a discrepancy',
  }
  return known[action] ?? action.replace(/[._]/g, ' ')
}

export function RecentActivity({ rows, now }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500 shadow-sm">
        No activity yet — recent reads, writes, and audited actions will appear
        here.
      </div>
    )
  }
  const reference = now ?? new Date()
  return (
    <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white shadow-sm">
      {rows.map((r) => {
        const actor = r.actorEmail ?? 'system'
        const phrase = actionLabel(r.action)
        const targetWord = `${r.targetType}`
        return (
          <li key={r.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm">
                <span className="font-medium text-neutral-900">{actor}</span>{' '}
                <span className="text-neutral-700">{phrase}</span>{' '}
                {r.href ? (
                  <Link
                    href={r.href}
                    className="text-primary-700 hover:underline"
                  >
                    {targetWord}
                  </Link>
                ) : (
                  <span className="text-neutral-500">{targetWord}</span>
                )}
              </div>
              <time
                className="shrink-0 font-mono text-xs tabular-nums text-neutral-500"
                dateTime={r.occurredAt.toISOString()}
              >
                {formatRelativeTime(r.occurredAt, reference)}
              </time>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
