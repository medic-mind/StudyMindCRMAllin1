'use client'

// Cancelled / underpaid Direct Debit plans (ADR 0038). The Issues tab's
// companion to the defaulter table: it catches families who stopped a
// fixed-length plan part-way through without ever failing a payment, so they
// never showed up as defaulters. Read-only — every action stays human-confirmed
// on the working tabs (CLAUDE.md §3).

import Link from 'next/link'
import { useMemo, useState } from 'react'

import { NewTaskDialog } from '@/app/(app)/tasks/NewTaskDialog'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { CsvExportButton } from '@/components/ui/csv-export-button'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { formatDate, statusLabel } from './shared'

/** A compact "chase" action for an Issues row: open a follow-up task against the
 * contact/family, plus a jump to the contact. Shown only when the plan's
 * customer is linked (otherwise there is nobody to action). */
function RowActions({
  contactId,
  familyId,
  customerName,
}: {
  contactId: string | null
  familyId: string | null
  customerName: string | null
}) {
  if (!contactId && !familyId) {
    return <span className="text-xs text-neutral-400">link customer</span>
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <NewTaskDialog
        contactId={contactId ?? undefined}
        familyId={familyId ?? undefined}
        contactName={customerName ?? undefined}
        triggerLabel="Chase"
        triggerVariant="secondary"
        triggerSize="xs"
      />
    </div>
  )
}

function describeCadence(intervalUnit: string, interval: number): string {
  const unit =
    intervalUnit === 'weekly' ? 'week' : intervalUnit === 'yearly' ? 'year' : 'month'
  return interval > 1 ? `every ${interval} ${unit}s` : unit + 'ly'
}

type SortDir = 'asc' | 'desc'

/** Sort a copy of `items` by the chosen numeric/string key + direction. */
function useSortedRows<T>(
  items: T[],
  key: keyof T,
  dir: SortDir,
): T[] {
  return useMemo(() => {
    const sorted = [...items]
    sorted.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      return dir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [items, key, dir])
}

/** A clickable sort header cell. */
function SortTh<T>({
  label,
  field,
  sort,
  setSort,
  align = 'left',
}: {
  label: string
  field: keyof T
  sort: { key: keyof T; dir: SortDir }
  setSort: (s: { key: keyof T; dir: SortDir }) => void
  align?: 'left' | 'right' | 'center'
}) {
  const active = sort.key === field
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : ''
  return (
    <Th className={alignCls}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-neutral-900"
        onClick={() =>
          setSort({ key: field, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })
        }
      >
        {label}
        <span aria-hidden className="text-[10px] text-neutral-400">
          {active ? (sort.dir === 'desc' ? '▼' : '▲') : '↕'}
        </span>
      </button>
    </Th>
  )
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
  const [sort, setSort] = useState<{ key: keyof Shortfall; dir: SortDir }>({
    key: 'shortfallMinor',
    dir: 'desc',
  })
  const rows = useSortedRows(items, sort.key, sort.dir)

  if (query.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading cancelled plans…</p>
  }

  const totalShortfall = items.reduce((s, i) => s + i.shortfallMinor, 0)

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">
            Cancelled &amp; underpaid plans
          </h2>
          <p className="text-xs text-neutral-500">
            Plans cancelled from June 2026 onward only — earlier cancellations are managed
            separately.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {items.length > 0 ? (
            <p className="text-xs text-neutral-500">
              {items.length} plan{items.length === 1 ? '' : 's'} ·{' '}
              <span className="font-mono font-semibold tabular-nums text-red-700">
                {formatMoneyMinor(totalShortfall)}
              </span>{' '}
              still due
            </p>
          ) : null}
          {items.length > 0 ? (
            <CsvExportButton
              getRows={() => rows}
              fileNameBase="dd-cancelled-underpaid-plans"
              columns={[
                { header: 'Customer', value: (r: Shortfall) => r.customerName ?? '' },
                { header: 'GoCardless customer', value: (r: Shortfall) => r.gcCustomerId ?? '' },
                { header: 'Plan', value: (r: Shortfall) => r.name ?? '' },
                { header: 'Status', value: (r: Shortfall) => r.status },
                { header: 'Instalment (£)', value: (r: Shortfall) => r.amountMinor / 100 },
                { header: 'Collected count', value: (r: Shortfall) => r.collectedCount },
                { header: 'Contracted count', value: (r: Shortfall) => r.totalPaymentCount },
                { header: 'Total due (£)', value: (r: Shortfall) => r.expectedTotalMinor / 100 },
                { header: 'Collected (£)', value: (r: Shortfall) => r.collectedMinor / 100 },
                { header: 'Shortfall (£)', value: (r: Shortfall) => r.shortfallMinor / 100 },
                { header: 'Cancelled part-way', value: (r: Shortfall) => r.cancelledPartway },
              ]}
            />
          ) : null}
        </div>
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
                <SortTh<Shortfall>
                  label="Customer"
                  field="customerName"
                  sort={sort}
                  setSort={setSort}
                />
                <Th>Plan</Th>
                <SortTh<Shortfall>
                  label="Instalment"
                  field="amountMinor"
                  sort={sort}
                  setSort={setSort}
                  align="right"
                />
                <Th className="text-center">Collected</Th>
                <SortTh<Shortfall>
                  label="Total due"
                  field="expectedTotalMinor"
                  sort={sort}
                  setSort={setSort}
                  align="right"
                />
                <Th className="text-right">Collected</Th>
                <SortTh<Shortfall>
                  label="Shortfall"
                  field="shortfallMinor"
                  sort={sort}
                  setSort={setSort}
                  align="right"
                />
                <Th>Why</Th>
                <Th className="text-right">Action</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((s) => (
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
                  <Td className="text-right">
                    <RowActions
                      contactId={s.contactId}
                      familyId={s.familyId}
                      customerName={s.customerName}
                    />
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
  const [sort, setSort] = useState<{ key: keyof Arrears; dir: SortDir }>({
    key: 'estimatedArrearsMinor',
    dir: 'desc',
  })
  const rows = useSortedRows(items, sort.key, sort.dir)

  if (query.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading active plans…</p>
  }

  const totalArrears = items.reduce((s, i) => s + i.estimatedArrearsMinor, 0)

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-neutral-900">
          Active plans behind schedule
        </h2>
        <div className="flex items-center gap-3">
          {items.length > 0 ? (
            <p className="text-xs text-neutral-500">
              {items.length} plan{items.length === 1 ? '' : 's'} ·{' '}
              <span className="font-mono font-semibold tabular-nums text-amber-700">
                {formatMoneyMinor(totalArrears)}
              </span>{' '}
              est. arrears
            </p>
          ) : null}
          {items.length > 0 ? (
            <CsvExportButton
              getRows={() => rows}
              fileNameBase="dd-plans-behind-schedule"
              columns={[
                { header: 'Customer', value: (r: Arrears) => r.customerName ?? '' },
                { header: 'GoCardless customer', value: (r: Arrears) => r.gcCustomerId ?? '' },
                { header: 'Plan', value: (r: Arrears) => r.name ?? '' },
                { header: 'Instalment (£)', value: (r: Arrears) => r.amountMinor / 100 },
                { header: 'Collected count', value: (r: Arrears) => r.collectedCount },
                { header: 'Expected by now', value: (r: Arrears) => r.expectedByNow },
                { header: 'Behind', value: (r: Arrears) => r.missedCount },
                {
                  header: 'Est. arrears (£)',
                  value: (r: Arrears) => r.estimatedArrearsMinor / 100,
                },
              ]}
            />
          ) : null}
        </div>
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
                <SortTh<Arrears>
                  label="Customer"
                  field="customerName"
                  sort={sort}
                  setSort={setSort}
                />
                <Th>Plan</Th>
                <SortTh<Arrears>
                  label="Instalment"
                  field="amountMinor"
                  sort={sort}
                  setSort={setSort}
                  align="right"
                />
                <Th className="text-center">Collected vs due</Th>
                <SortTh<Arrears>
                  label="Behind"
                  field="missedCount"
                  sort={sort}
                  setSort={setSort}
                  align="center"
                />
                <SortTh<Arrears>
                  label="Est. arrears"
                  field="estimatedArrearsMinor"
                  sort={sort}
                  setSort={setSort}
                  align="right"
                />
                <Th>Next charge</Th>
                <Th className="text-right">Action</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((s) => (
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
                  <Td className="text-right">
                    <RowActions
                      contactId={s.contactId}
                      familyId={s.familyId}
                      customerName={s.customerName}
                    />
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
