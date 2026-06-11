'use client'

// GoCardless payouts tab (ADR 0038 parity pass 2): the batch transfers of
// collected funds to the StudyMind bank account, with the proper list
// system — status chips, arrival-date range filter, sorting, paging with
// totals, and CSV export. Read-only mirror.

import Link from 'next/link'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { CsvExportButton } from '@/components/ui/csv-export-button'
import { PageSizeSelect, PaginationBar, SortMenu } from '@/components/ui/list-controls'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import {
  FilterChips,
  formatDate,
  ParamInput,
  readDateParam,
  readPageSort,
  useListParams,
} from './shared'

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

const SORT_FIELDS = ['arrivalDate', 'amountMinor', 'createdAt'] as const
type SortField = (typeof SORT_FIELDS)[number]

const SORT_OPTIONS = [
  { value: 'arrivalDate', label: 'Arrival date' },
  { value: 'amountMinor', label: 'Amount' },
  { value: 'createdAt', label: 'Imported' },
]

const EXPORT_CAP = 5000

export function PayoutsTab() {
  const { get, set } = useListParams()

  const statusRaw = get('status', 'all')
  const status: StatusFilter = STATUS_OPTIONS.some((o) => o.value === statusRaw)
    ? (statusRaw as StatusFilter)
    : 'all'
  const { page, pageSize, sortBy, sortDir } = readPageSort(get, { sortBy: 'arrivalDate' })
  const sortField: SortField = SORT_FIELDS.includes(sortBy as SortField)
    ? (sortBy as SortField)
    : 'arrivalDate'

  const listInput = {
    status,
    ...(readDateParam(get('from')) ? { arrivalFrom: readDateParam(get('from')) } : {}),
    ...(readDateParam(get('to'), true) ? { arrivalTo: readDateParam(get('to'), true) } : {}),
    sortBy: sortField,
    sortDir,
    page,
    pageSize,
  }

  const utils = trpc.useUtils()
  const list = trpc.gocardless.payouts.list.useQuery(listInput, {
    placeholderData: (prev) => prev,
  })
  const items = list.data?.items ?? []
  const total = list.data?.total ?? 0

  const exportRows = async () => {
    const rows: Array<Record<string, unknown>> = []
    let exportPage = 1
    for (;;) {
      const res = await utils.gocardless.payouts.list.fetch({
        ...listInput,
        page: exportPage,
        pageSize: 100,
      })
      for (const r of res.items) {
        rows.push({
          arrivalDate: r.arrivalDate ? new Date(r.arrivalDate).toISOString().slice(0, 10) : '',
          reference: r.reference ?? '',
          amount: (r.amountMinor / 100).toFixed(2),
          fees: r.deductedFeesMinor !== null ? (r.deductedFeesMinor / 100).toFixed(2) : '',
          payments: r.paymentCount,
          status: r.status,
          gcPayoutId: r.gcPayoutId,
        })
      }
      if (rows.length >= Math.min(res.total, EXPORT_CAP) || res.items.length === 0) break
      exportPage += 1
    }
    return rows
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChips
          options={STATUS_OPTIONS}
          value={status}
          onChange={(v) => set({ status: v === 'all' ? null : v })}
        />
        <span className="flex items-center gap-1 text-xs text-neutral-500">
          Arrived
          <ParamInput param="from" type="date" label="Arrival from" width="w-34" />
          –
          <ParamInput param="to" type="date" label="Arrival to" width="w-34" />
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SortMenu options={SORT_OPTIONS} defaultValue="arrivalDate" />
          <PageSizeSelect defaultValue={50} options={[25, 50, 100]} />
          <CsvExportButton
            getRows={exportRows}
            columns={[
              { header: 'Arrival date', value: (r) => String(r['arrivalDate'] ?? '') },
              { header: 'Reference', value: (r) => String(r['reference'] ?? '') },
              { header: 'Amount', value: (r) => String(r['amount'] ?? '') },
              { header: 'Fees deducted', value: (r) => String(r['fees'] ?? '') },
              { header: 'Payments', value: (r) => String(r['payments'] ?? '') },
              { header: 'Status', value: (r) => String(r['status'] ?? '') },
              { header: 'GoCardless id', value: (r) => String(r['gcPayoutId'] ?? '') },
            ]}
            fileNameBase="gocardless-payouts"
          />
        </div>
      </div>

      {list.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading payouts…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">No payouts match these filters.</p>
          <p className="mt-1 text-sm text-neutral-500">
            Payouts arrive live from GoCardless webhooks; run the import to pull the history.
          </p>
        </div>
      ) : (
        <>
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
                      <code className="font-mono text-[11px] text-neutral-400">
                        {p.gcPayoutId}
                      </code>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <PaginationBar page={page} pageSize={pageSize} total={total} shown={items.length} />
            <span className="text-xs text-neutral-500">
              Filtered total:{' '}
              <span className="font-mono tabular-nums text-neutral-700">
                {formatMoneyMinor(list.data?.totalAmountMinor ?? 0)}
              </span>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
