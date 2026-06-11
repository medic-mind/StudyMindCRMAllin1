'use client'

// Payout drill-down (ADR 0038 parity pass 2): one bank transfer and the
// customer payments that made it up. Read-only.

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { formatDate, PAYMENT_TONE, statusLabel } from './shared'
import { PAYOUT_TONE } from './PayoutsTab'

export function PayoutDetail({ gcPayoutId }: { gcPayoutId: string }) {
  const detail = trpc.gocardless.payouts.detail.useQuery({ gcPayoutId })

  if (detail.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading payout…</p>
  }
  const data = detail.data
  if (!data) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
        <p className="text-sm font-medium text-neutral-700">Payout not found.</p>
        <Link
          href="/direct-debits/payouts"
          className="mt-2 inline-block text-sm font-medium text-primary-700 hover:underline"
        >
          ← Back to payouts
        </Link>
      </div>
    )
  }

  const { payout } = data

  return (
    <div className="space-y-4">
      <Link
        href="/direct-debits/payouts"
        className="inline-block text-sm text-neutral-500 hover:text-neutral-900"
      >
        ← Payouts
      </Link>

      <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-mono text-lg font-semibold tabular-nums text-neutral-900">
              {formatMoneyMinor(payout.amountMinor, payout.currency)}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
              <Badge tone={PAYOUT_TONE[payout.status] ?? 'neutral'} dot>
                {payout.status}
              </Badge>
              <span>Arrival {formatDate(payout.arrivalDate)}</span>
              {payout.reference ? <span>ref {payout.reference}</span> : null}
              <code className="font-mono text-xs text-neutral-400">{payout.gcPayoutId}</code>
            </div>
          </div>
          <div className="text-right text-sm text-neutral-600">
            {payout.deductedFeesMinor !== null ? (
              <div>
                Fees deducted:{' '}
                <span className="font-mono tabular-nums">
                  {formatMoneyMinor(payout.deductedFeesMinor, payout.currency)}
                </span>
              </div>
            ) : null}
            <div>
              Settled payments mirrored:{' '}
              <span className="font-mono tabular-nums">
                {formatMoneyMinor(data.settledTotalMinor, payout.currency)}
              </span>{' '}
              ({data.payments.length})
            </div>
          </div>
        </div>
      </div>

      <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
        <div className="border-b border-neutral-100 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-neutral-900">Payments in this payout</h3>
        </div>
        {data.payments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">
            No mirrored payments reference this payout yet — they link up as their paid-out
            webhooks arrive, or after the next import.
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Customer</Th>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th>Charge date</Th>
                <Th>Description</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.payments.map((p) => (
                <Tr key={p.gcPaymentId}>
                  <Td>
                    {p.customer?.contactId ? (
                      <Link
                        href={`/contacts/${p.customer.contactId}`}
                        className="font-medium text-primary-700 hover:underline"
                      >
                        {p.customer.contactName ?? p.customer.displayName}
                      </Link>
                    ) : p.customer ? (
                      <Link
                        href={`/direct-debits/customers/${encodeURIComponent(p.customer.gcCustomerId)}`}
                        className="font-medium text-neutral-700 hover:text-primary-700 hover:underline"
                      >
                        {p.customer.displayName}
                      </Link>
                    ) : (
                      <span className="text-neutral-700">—</span>
                    )}
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {formatMoneyMinor(p.amountMinor, p.currency)}
                  </Td>
                  <Td>
                    <Badge tone={PAYMENT_TONE[p.status] ?? 'neutral'} dot>
                      {statusLabel(p.status)}
                    </Badge>
                  </Td>
                  <Td className="text-neutral-600">{formatDate(p.chargeDate)}</Td>
                  <Td className="max-w-[18rem] truncate text-neutral-600">
                    {p.description ?? '—'}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </section>
    </div>
  )
}
