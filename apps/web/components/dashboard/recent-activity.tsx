// Recent activity feed for the dashboard. Renders the last N AuditLogEntry
// rows the caller is allowed to see, in a headed card. RSC — pure presentational.

import Link from 'next/link'

import { Card, CardHeader, CardTitle } from '@/components/ui/card'
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
    'complaint.created': 'logged a complaint',
    'complaint.resolved': 'resolved a complaint',
    'business_account.note_added': 'added an account note',
    'mail.composed': 'sent an email',
    'mail.thread_replied': 'replied to an email',
    'reconciliation.discrepancy_resolved': 'resolved a discrepancy',
  }
  return known[action] ?? action.replace(/[._]/g, ' ')
}

function initialOf(actor: string): string {
  const trimmed = actor.trim()
  return trimmed ? trimmed[0]!.toUpperCase() : '·'
}

export function RecentActivity({ rows, now }: Props) {
  const reference = now ?? new Date()
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <span className="text-xs text-neutral-400">Audit log</span>
      </CardHeader>
      {rows.length === 0 ? (
        <div className="p-6 text-sm text-neutral-500">
          No activity yet — recent writes and audited actions will appear here.
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {rows.map((r) => {
            const actor = r.actorEmail ?? 'system'
            const phrase = actionLabel(r.action)
            const targetWord = `${r.targetType}`
            return (
              <li key={r.id} className="flex items-start gap-3 px-5 py-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-50 text-[11px] font-semibold text-primary-700 ring-1 ring-inset ring-primary-100"
                >
                  {initialOf(actor)}
                </span>
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium text-neutral-900">{actor}</span>{' '}
                  <span className="text-neutral-600">{phrase}</span>{' '}
                  {r.href ? (
                    <Link href={r.href} className="text-primary-700 hover:underline">
                      {targetWord}
                    </Link>
                  ) : (
                    <span className="text-neutral-500">{targetWord}</span>
                  )}
                </div>
                <time
                  className="shrink-0 font-mono text-xs tabular-nums text-neutral-400"
                  dateTime={r.occurredAt.toISOString()}
                >
                  {formatRelativeTime(r.occurredAt, reference)}
                </time>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
