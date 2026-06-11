'use client'

// GoCardless payouts tab (ADR 0038 parity pass 2): the batch transfers of
// collected funds to the StudyMind bank account. Read-only mirror — payouts
// are provider-side money movement; nothing here mutates.

import Link from 'next/link'
import { useState } from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { FilterChips, formatDate } from './shared'

export const PAYOUT_TONE: Record<string, BadgeTone> = {
  paid: 'success',
  pending: 'info',
  bounced: 'danger',
}

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'bounced', label: 'Bounced' },
] as const

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value']

export function PayoutsTab() {
  const [status, setStatus] = useState<StatusFilter>('all')
  const list = trpc.gocardless.payouts.list.useQuery({ status })
  const items = list.data?.items ?? []

  return (
    <div className="space-y-3">
      <FilterChips options={STATUS_OPTIONS} value={status} onChange={setStatus} />

      {list.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading payouts…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">No payouts mirrored yet.</p>
          <p className="mt-1 text-sm text-neutral-500">
            Payouts arrive live from GoCardless webhooks; run the import to pull the history.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
          <Table>
            <Thead>
              <Tr>
                <Th>Arrival date</Th>
                <Th>Reference</Th>
                <Th className="text-right">Amount</Th>
                <Th className="text-right">Fees deducted</Th>
                <Th className="text-right">Payments</Th>
                <Th>Status</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {items.map((p) => (
                <Tr key={p.gcPayoutId}>
                  <Td className="text-neutral-900">{formatDate(p.arrivalDate)}</Td>
                  <Td>
                    <span className="text-neutral-700">{p.reference ?? '—'}</span>{' '}
                    <code className="font-mono text-[11px] text-neutral-400">{p.gcPayoutId}</code>
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {formatMoneyMinor(p.amountMinor, p.currency)}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-neutral-600">
                    {p.deductedFeesMinor !== null
                      ? formatMoneyMinor(p.deductedFeesMinor, p.currency)
                      : '—'}
                  </Td>
                  <Td className="text-right tabular-nums">{p.paymentCount}</Td>
                  <Td>
                    <Badge tone={PAYOUT_TONE[p.status] ?? 'neutral'} dot>
                      {p.status}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="flex justify-end">
                      <Link
                        href={`/direct-debits/payouts/${encodeURIComponent(p.gcPayoutId)}`}
                        className="text-xs font-medium text-primary-700 hover:underline"
                      >
                        View →
                      </Link>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </div>
      )}
    </div>
  )
}
