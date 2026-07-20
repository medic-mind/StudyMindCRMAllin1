'use client'

// Client island for the Stripe camp-purchases tray: view chips, stat tiles,
// the detections table, and the retry / dismiss / scan actions.

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CheckCircleIcon, CoinsIcon, SparklesIcon } from '@/components/ui/icon'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'
import { cn } from '@/lib/cn'

import { PurchaseStatusBadge } from '../camp-status'
import { StatTile } from '../StatTile'

type View = 'open' | 'resolved' | 'all'

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })
function money(minor: number, currency: string): string {
  if (currency.toLowerCase() === 'gbp') return gbp.format(minor / 100)
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100)
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

export function PurchasesWorkspace({ canAct, canScan }: { canAct: boolean; canScan: boolean }) {
  const [view, setView] = useState<View>('open')
  const utils = trpc.useUtils()
  const list = trpc.summerCamp.purchases.list.useQuery(
    { view },
    { placeholderData: (prev) => prev, refetchOnWindowFocus: false },
  )

  const refresh = () => void utils.summerCamp.purchases.list.invalidate()
  const retry = trpc.summerCamp.purchases.retry.useMutation({
    onSuccess: () => {
      toast.success('Retry queued — the booking is created in the background')
      setTimeout(refresh, 4000)
    },
    onError: (err) => toast.error(err.message),
  })
  const dismiss = trpc.summerCamp.purchases.dismiss.useMutation({
    onSuccess: () => {
      toast.success('Dismissed — kept on record, never acted on again')
      refresh()
    },
    onError: (err) => toast.error(err.message),
  })
  const scan = trpc.summerCamp.purchases.scanStripe.useMutation({
    onSuccess: () => {
      toast.success('Scanning the last 12 months of Stripe payments — matches appear here shortly')
      setTimeout(refresh, 8000)
    },
    onError: (err) => toast.error(err.message),
  })

  const counts = list.data?.counts ?? {}
  const openCount = (counts['pending'] ?? 0) + (counts['failed'] ?? 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile
          icon={<SparklesIcon size={18} />}
          tone="warn"
          label="Needs attention"
          value={openCount}
          hint="pending or failed"
        />
        <StatTile
          icon={<CheckCircleIcon size={18} />}
          tone="success"
          label="Bookings created"
          value={counts['booking_created'] ?? 0}
        />
        <StatTile
          icon={<CoinsIcon size={18} />}
          tone="neutral"
          label="Dismissed"
          value={counts['dismissed'] ?? 0}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['open', 'resolved', 'all'] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            aria-pressed={view === v}
            className={cn(
              'rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors',
              view === v
                ? 'border-primary-200 bg-primary-50 text-primary-700'
                : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300',
            )}
          >
            {v === 'open' ? `Needs attention (${openCount})` : v === 'resolved' ? 'Resolved' : 'All'}
          </button>
        ))}
        {canScan ? (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            disabled={scan.isPending || list.data?.stripeConfigured === false}
            title={list.data?.stripeConfigured === false ? 'Stripe is not configured' : undefined}
            onClick={() => {
              const sure = window.confirm(
                'Scan the last 12 months of Stripe payments? Every match auto-creates a camp booking (already-imported payments are skipped).',
              )
              if (sure) scan.mutate({ days: 365 })
            }}
          >
            {scan.isPending ? 'Scanning…' : 'Scan last 12 months'}
          </Button>
        ) : null}
      </div>

      {list.data && !list.data.campConnected && openCount > 0 ? (
        <Card className="border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-800">
          The Summer Camp app is not connected, so detected purchases cannot become bookings yet —
          connect it (Overview page), then Retry the rows below.
        </Card>
      ) : null}

      {list.error ? (
        <Card variant="dashed" className="p-8 text-center text-sm text-red-700">
          Could not load purchases: {list.error.message}
        </Card>
      ) : (list.data?.items.length ?? 0) === 0 && !list.isLoading ? (
        <Card variant="dashed" className="p-10 text-center">
          <SparklesIcon size={40} className="mx-auto text-neutral-200" />
          <p className="mt-3 text-sm font-medium text-neutral-800">
            {view === 'open' ? 'Nothing needs attention' : 'No purchases here yet'}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
            New Stripe payments mentioning “summer camp” or “work experience” are picked up
            automatically{canScan ? ' — or scan past payments with the button above' : ''}.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <Thead>
              <Tr>
                <Th>Paid</Th>
                <Th>Customer</Th>
                <Th className="text-right">Amount</Th>
                <Th>Matched</Th>
                <Th>Stripe product text</Th>
                <Th>Status</Th>
                <Th>Links</Th>
                {canAct ? <Th /> : null}
              </Tr>
            </Thead>
            <Tbody>
              {(list.data?.items ?? []).map((p) => (
                <Tr key={p.id}>
                  <Td className="whitespace-nowrap py-2.5">{fmtDate(p.occurredAt ?? p.createdAt)}</Td>
                  <Td className="py-2.5">
                    <span className="block font-medium text-neutral-900">{p.customerName ?? 'Unknown'}</span>
                    <span className="block text-xs text-neutral-400">{p.customerEmail ?? ''}</span>
                  </Td>
                  <Td className="whitespace-nowrap py-2.5 text-right tabular-nums">
                    {money(p.amountMinor, p.currency)}
                  </Td>
                  <Td className="py-2.5">
                    <Badge tone={p.matchedKeyword === 'summer_camp' ? 'info' : 'accent'}>
                      {p.matchedKeyword === 'summer_camp' ? 'Summer Camp' : 'Work Experience'}
                    </Badge>
                  </Td>
                  <Td className="max-w-[260px] py-2.5">
                    <span className="block truncate text-xs text-neutral-600" title={p.productText ?? ''}>
                      {p.productText ?? '—'}
                    </span>
                  </Td>
                  <Td className="py-2.5">
                    <PurchaseStatusBadge status={p.status} />
                    {p.error && p.status !== 'booking_created' ? (
                      <span className="mt-0.5 block max-w-[220px] text-[11px] text-red-600">{p.error}</span>
                    ) : null}
                  </Td>
                  <Td className="py-2.5">
                    <span className="flex flex-col gap-0.5 text-xs">
                      {p.externalBookingId ? (
                        <Link
                          href={`/camps/bookings?q=${encodeURIComponent(p.stripeChargeId)}`}
                          className="font-medium text-primary-700 hover:underline"
                        >
                          View booking
                        </Link>
                      ) : null}
                      {p.contactId ? (
                        <Link href={`/contacts/${p.contactId}`} className="font-medium text-primary-700 hover:underline">
                          {p.contactName ?? 'Contact'}
                        </Link>
                      ) : null}
                    </span>
                  </Td>
                  {canAct ? (
                    <Td className="py-2.5">
                      {p.status === 'pending' || p.status === 'failed' ? (
                        <span className="flex gap-1.5">
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={retry.isPending}
                            onClick={() => retry.mutate({ id: p.id })}
                          >
                            Retry
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={dismiss.isPending}
                            onClick={() => dismiss.mutate({ id: p.id })}
                          >
                            Dismiss
                          </Button>
                        </span>
                      ) : null}
                    </Td>
                  ) : null}
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}
      <p className="text-[11px] text-neutral-400">
        Detection is conservative: only Stripe payments whose product text contains “summer camp” or
        “work experience” match. Each match is entered into the Summer Camp app as a confirmed
        booking (flagged for camp assignment) and recorded here and on the customer&apos;s timeline.
      </p>
    </div>
  )
}
