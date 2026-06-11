'use client'

// GoCardless activity feed (ADR 0038 parity pass 2). Every webhook event the
// CRM has ever received, read straight from the ProviderEvent replay log and
// resolved to customers through the mirror — so the feed reads as people and
// money, not ids. Read-only by definition.

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { FilterChips, statusLabel } from './shared'

const RESOURCE_OPTIONS = [
  { value: 'all', label: 'All activity' },
  { value: 'payments', label: 'Payments' },
  { value: 'subscriptions', label: 'Plans' },
  { value: 'mandates', label: 'Mandates' },
  { value: 'payouts', label: 'Payouts' },
] as const

type ResourceFilter = (typeof RESOURCE_OPTIONS)[number]['value']

// Action → tone so the feed scans like the status chips elsewhere.
const ACTION_TONE: Record<string, BadgeTone> = {
  confirmed: 'success',
  paid_out: 'success',
  paid: 'success',
  active: 'success',
  customer_approval_granted: 'success',
  created: 'info',
  submitted: 'info',
  resumed: 'info',
  payment_created: 'info',
  amended: 'info',
  paused: 'warn',
  late_failure_settled: 'danger',
  failed: 'danger',
  charged_back: 'danger',
  customer_approval_denied: 'danger',
  cancelled: 'neutral',
  finished: 'neutral',
  expired: 'warn',
  replaced: 'neutral',
}

const RESOURCE_LABEL: Record<string, string> = {
  payments: 'Payment',
  mandates: 'Mandate',
  subscriptions: 'Plan',
  payouts: 'Payout',
  refunds: 'Refund',
}

const TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

export function ActivityTab() {
  const [resourceType, setResourceType] = useState<ResourceFilter>('all')
  const [cursor, setCursor] = useState<{ id: string; receivedAt: Date } | null>(null)
  const [extraItems, setExtraItems] = useState<FeedItem[]>([])

  const list = trpc.gocardless.events.list.useQuery({
    resourceType,
    cursor: null,
  })
  const more = trpc.gocardless.events.list.useQuery(
    { resourceType, cursor },
    { enabled: cursor !== null },
  )

  // First page + any "load more" pages the user pulled in. Pages are
  // appended once each; the id guard makes a refetch idempotent.
  const firstPage = list.data?.items ?? []
  const morePage = more.data?.items
  useEffect(() => {
    if (!morePage || morePage.length === 0) return
    setExtraItems((prev) => {
      const known = new Set(prev.map((i) => i.id))
      const fresh = morePage.filter((i) => !known.has(i.id))
      return fresh.length > 0 ? [...prev, ...fresh] : prev
    })
  }, [morePage])
  const firstIds = new Set(firstPage.map((i) => i.id))
  const items = [...firstPage, ...extraItems.filter((i) => !firstIds.has(i.id))]
  const nextCursor = (cursor === null ? list.data?.nextCursor : more.data?.nextCursor) ?? null

  const changeFilter = (value: ResourceFilter) => {
    setResourceType(value)
    setCursor(null)
    setExtraItems([])
  }

  return (
    <div className="space-y-3">
      <FilterChips options={RESOURCE_OPTIONS} value={resourceType} onChange={changeFilter} />

      {list.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading activity…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">No activity recorded yet.</p>
          <p className="mt-1 text-sm text-neutral-500">
            Every GoCardless webhook lands here the moment it arrives — payments confirming,
            mandates activating, plans changing, payouts settling.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
          <ul className="divide-y divide-neutral-100">
            {items.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
          {nextCursor ? (
            <div className="border-t border-neutral-100 p-2 text-center">
              <Button
                size="sm"
                variant="ghost"
                disabled={more.isFetching}
                onClick={() =>
                  setCursor({
                    id: nextCursor.id,
                    receivedAt: new Date(nextCursor.receivedAt),
                  })
                }
              >
                {more.isFetching ? 'Loading…' : 'Load older activity'}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

interface FeedItem {
  id: string
  eventId: string
  type: string
  receivedAt: Date
  description: string | null
  resourceId: string | null
  amountMinor: number | null
  currency: string | null
  planName: string | null
  customer: {
    gcCustomerId: string
    displayName: string
    contactId: string | null
    contactName: string | null
  } | null
}

function EventRow({ event }: { event: FeedItem }) {
  const [resource = '', action = ''] = event.type.split('/')
  const label = RESOURCE_LABEL[resource] ?? resource

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone={ACTION_TONE[action] ?? 'neutral'} dot>
          {label} {statusLabel(action)}
        </Badge>
        {event.customer ? (
          event.customer.contactId ? (
            <Link
              href={`/contacts/${event.customer.contactId}`}
              className="font-medium text-primary-700 hover:underline"
            >
              {event.customer.contactName ?? event.customer.displayName}
            </Link>
          ) : (
            <Link
              href={`/direct-debits/customers/${encodeURIComponent(event.customer.gcCustomerId)}`}
              className="font-medium text-neutral-700 hover:text-primary-700 hover:underline"
            >
              {event.customer.displayName}
            </Link>
          )
        ) : null}
        {event.amountMinor !== null ? (
          <span className="font-mono tabular-nums text-neutral-900">
            {formatMoneyMinor(event.amountMinor, event.currency ?? 'GBP')}
          </span>
        ) : null}
        {event.planName ? (
          <span className="text-xs text-neutral-500">{event.planName}</span>
        ) : null}
        {event.description ? (
          <span className="hidden max-w-[24rem] truncate text-xs text-neutral-400 lg:inline">
            {event.description}
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-3">
        {event.resourceId ? (
          <code className="font-mono text-[11px] text-neutral-400">{event.resourceId}</code>
        ) : null}
        <span className="whitespace-nowrap text-xs text-neutral-500">
          {TIME.format(new Date(event.receivedAt))}
        </span>
      </span>
    </li>
  )
}
