'use client'

// Cancelled / underpaid Direct Debit plans (ADR 0038). The Issues tab's
// companion to the defaulter table: it catches families who stopped a
// fixed-length plan part-way through without ever failing a payment, so they
// never showed up as defaulters. Read-only — every action stays human-confirmed
// on the working tabs (CLAUDE.md §3).

import Link from 'next/link'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { formatDate, statusLabel } from './shared'

function describeCadence(intervalUnit: string, interval: number): string {
  const unit =
    intervalUnit === 'weekly' ? 'week' : intervalUnit === 'yearly' ? 'year' : 'month'
  return interval > 1 ? `every ${interval} ${unit}s` : unit + 'ly'
}

const REASON_LABEL: Record<string, string> = {
  cancelled_partway: 'Cancelled part-way',
  collection_shortfall: 'Collection shortfall',
  finished_underpaid: 'Finished underpaid',
}

const REASON_TONE: Record<string, BadgeTone> = {
  cancelled_partway: 'danger',
  collection_shortfall: 'warn',
  finished_underpaid: 'warn',
}

interface Shortfall {
  gcSubscriptionId: string
  name: string | null
  status: string
  currency: string
  amountMinor: number
  totalPaymentCount: number
  collectedCount: number
  expectedTotalMinor: number
  collectedMinor: number
  shortfallMinor: number
  missedCount: number
  cancelledPartway: boolean
  endDate: Date | string | null
  lastCollectedAt: Date | string | null
  gcCustomerId: string | null
  customerName: string | null
  contactId: string | null
  familyId: string | null
  reasons: string[]
}

function CustomerCell({
  s,
}: {
  s: { customerName: string | null; gcCustomerId: string | null }
}) {
  const label = s.customerName ?? (s.gcCustomerId ? s.gcCustomerId : 'Unlinked customer')
  if (s.gcCustomerId) {
    return (
      <Link
        href={`/direct-debits/customers/${s.gcCustomerId}`}
        className="font-medium text-primary-700 hover:underline"
      >
        {label}
      </Link>
    )
  }
  return <span className="font-medium text-neutral-700">{label}</span>
}

export function PlanShortfallsSection() {
  const query = trpc.finance.directDebit.listPlanShortfalls.useQuery({})
  const items = (query.data?.items ?? []) as Shortfall[]

  if (query.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading cancelled plans…</p>
  }

  const totalShortfall = items.reduce((s, i) => s + i.shortfallMinor, 0)

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-neutral-900">
          Cancelled &amp; underpaid plans
        </h2>
        {items.length > 0 ? (
          <p className="text-xs text-neutral-500">
            {items.length} plan{items.length === 1 ? '' : 's'} ·{' '}
            <span className="font-mono font-semibold tabular-nums text-red-700">
              {formatMoneyMinor(totalShortfall)}
            </span>{' '}
            still due
          </p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500 shadow-card">
          No fixed-length plan ended with money uncollected — every plan was either
          completed or is still running.
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
          <Table>
            <Thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Plan</Th>
                <Th className="text-right">Instalment</Th>
                <Th className="text-center">Collected</Th>
                <Th className="text-right">Total due</Th>
                <Th className="text-right">Collected</Th>
                <Th className="text-right">Shortfall</Th>
                <Th>Why</Th>
              </Tr>
            </Thead>
            <Tbody>
              {items.map((s) => (
                <Tr key={s.gcSubscriptionId}>
                  <Td>
                    <CustomerCell s={s} />
                    {s.contactId ? (
                      <Link
                        href={`/contacts/${s.contactId}`}
                        className="ml-2 text-xs text-neutral-500 hover:underline"
                      >
                        view contact
                      </Link>
                    ) : null}
                  </Td>
                  <Td>
                    <div className="text-sm text-neutral-800">{s.name ?? '—'}</div>
                    <div className="text-xs text-neutral-500">
                      <Badge tone={s.cancelledPartway ? 'danger' : 'neutral'}>
                        {statusLabel(s.status)}
                      </Badge>{' '}
                      {s.endDate ? `ended ${formatDate(s.endDate)}` : null}
                    </div>
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {formatMoneyMinor(s.amountMinor, s.currency)}
                  </Td>
                  <Td className="text-center font-mono tabular-nums">
                    <span className={s.missedCount > 0 ? 'text-red-700' : 'text-neutral-700'}>
                      {s.collectedCount} / {s.totalPaymentCount}
                    </span>
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-neutral-700">
                    {formatMoneyMinor(s.expectedTotalMinor, s.currency)}
                  </Td>
                  <Td className="text-right font-mono tabular-nums text-neutral-700">
                    {formatMoneyMinor(s.collectedMinor, s.currency)}
                  </Td>
                  <Td className="text-right font-mono font-semibold tabular-nums text-red-700">
                    {formatMoneyMinor(s.shortfallMinor, s.currency)}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {s.reasons?.map((r) => (
                        <Badge key={r} tone={REASON_TONE[r] ?? 'warn'}>
                          {REASON_LABEL[r] ?? r}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </div>
      )}
    </section>
  )
}

interface Arrears {
  gcSubscriptionId: string
  name: string | null
  currency: string
  amountMinor: number
  intervalUnit: string
  interval: number
  expectedByNow: number
  collectedCount: number
  missedCount: number
  estimatedArrearsMinor: number
  totalPaymentCount: number | null
  nextChargeAt: Date | string | null
  lastCollectedAt: Date | string | null
  gcCustomerId: string | null
  customerName: string | null
  contactId: string | null
  familyId: string | null
}

export function ActivePlanArrearsSection() {
  const query = trpc.finance.directDebit.listActivePlanArrears.useQuery({})
  const items = (query.data?.items ?? []) as Arrears[]

  if (query.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading active plans…</p>
  }

  const totalArrears = items.reduce((s, i) => s + i.estimatedArrearsMinor, 0)

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-neutral-900">
          Active plans behind schedule
        </h2>
        {items.length > 0 ? (
          <p className="text-xs text-neutral-500">
            {items.length} plan{items.length === 1 ? '' : 's'} ·{' '}
            <span className="font-mono font-semibold tabular-nums text-amber-700">
              {formatMoneyMinor(totalArrears)}
            </span>{' '}
            est. arrears
          </p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500 shadow-card">
          No active plan is behind its collection schedule.
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
          <p className="border-b border-neutral-100 px-3 py-2 text-xs text-neutral-500">
            Estimated from each plan&apos;s cadence and start date — GoCardless owns the exact
            schedule. Plans at least two instalments behind are shown for a human to check.
          </p>
          <Table>
            <Thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Plan</Th>
                <Th className="text-right">Instalment</Th>
                <Th className="text-center">Collected vs due</Th>
                <Th className="text-center">Behind</Th>
                <Th className="text-right">Est. arrears</Th>
                <Th>Next charge</Th>
              </Tr>
            </Thead>
            <Tbody>
              {items.map((s) => (
                <Tr key={s.gcSubscriptionId}>
                  <Td>
                    <CustomerCell s={s} />
                    {s.contactId ? (
                      <Link
                        href={`/contacts/${s.contactId}`}
                        className="ml-2 text-xs text-neutral-500 hover:underline"
                      >
                        view contact
                      </Link>
                    ) : null}
                  </Td>
                  <Td>
                    <div className="text-sm text-neutral-800">{s.name ?? '—'}</div>
                    <div className="text-xs text-neutral-500">
                      {describeCadence(s.intervalUnit, s.interval)}
                      {s.totalPaymentCount ? ` · ${s.totalPaymentCount} payments` : ''}
                    </div>
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {formatMoneyMinor(s.amountMinor, s.currency)}
                  </Td>
                  <Td className="text-center font-mono tabular-nums text-neutral-700">
                    {s.collectedCount} / {s.expectedByNow}
                  </Td>
                  <Td className="text-center">
                    <Badge tone="warn">{s.missedCount}</Badge>
                  </Td>
                  <Td className="text-right font-mono font-semibold tabular-nums text-amber-700">
                    {formatMoneyMinor(s.estimatedArrearsMinor, s.currency)}
                  </Td>
                  <Td className="text-xs text-neutral-500">{formatDate(s.nextChargeAt)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </div>
      )}
    </section>
  )
}
