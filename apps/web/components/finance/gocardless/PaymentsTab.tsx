'use client'

// GoCardless payments tab (ADR 0038): the complete payment mirror with a
// proper list system — status tabs with live counts, customer search, charge
// date + amount range filters, whitelisted column sorting, paging with
// totals, and CSV export. All list state lives in the URL (CLAUDE.md §26).
// Collect / cancel / retry stay human-confirmed (§3).

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CsvExportButton } from '@/components/ui/csv-export-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageSizeSelect, PaginationBar, SortMenu } from '@/components/ui/list-controls'
import { SearchField } from '@/components/ui/search-field'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import {
  CustomerMandatePicker,
  FilterChips,
  formatDate,
  PAYMENT_TONE,
  ParamInput,
  readDateParam,
  readPageSort,
  readPoundsParam,
  statusLabel,
  useListParams,
  type PickedMandate,
} from './shared'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'pending_submission', label: 'Pending' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'paid_out', label: 'Paid out' },
  { value: 'failed', label: 'Failed' },
  { value: 'charged_back', label: 'Charged back' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value']

const SORT_FIELDS = ['chargeDate', 'amountMinor', 'createdAt', 'gcCreatedAt'] as const
type SortField = (typeof SORT_FIELDS)[number]

const SORT_OPTIONS = [
  { value: 'chargeDate', label: 'Charge date' },
  { value: 'amountMinor', label: 'Amount' },
  { value: 'gcCreatedAt', label: 'Created (GoCardless)' },
  { value: 'createdAt', label: 'Imported' },
]

const CANCELLABLE = new Set(['pending_customer_approval', 'pending_submission'])

const EXPORT_CAP = 5000

export function PaymentsTab() {
  const { get, set } = useListParams()

  const customerFilter = get('customer') || null
  const statusRaw = get('status', 'all')
  const status: StatusFilter = STATUS_OPTIONS.some((o) => o.value === statusRaw)
    ? (statusRaw as StatusFilter)
    : 'all'
  const q = get('q').trim()
  const { page, pageSize, sortBy, sortDir } = readPageSort(get, { sortBy: 'chargeDate' })
  const sortField: SortField = SORT_FIELDS.includes(sortBy as SortField)
    ? (sortBy as SortField)
    : 'chargeDate'

  const filterInput = {
    ...(customerFilter ? { gcCustomerId: customerFilter } : {}),
    ...(!customerFilter && q.length >= 2 ? { q } : {}),
    ...(readDateParam(get('from')) ? { chargeDateFrom: readDateParam(get('from')) } : {}),
    ...(readDateParam(get('to'), true) ? { chargeDateTo: readDateParam(get('to'), true) } : {}),
    ...(readPoundsParam(get('min')) !== undefined
      ? { amountMinMinor: readPoundsParam(get('min')) }
      : {}),
    ...(readPoundsParam(get('max')) !== undefined
      ? { amountMaxMinor: readPoundsParam(get('max')) }
      : {}),
  }
  const listInput = {
    status,
    ...filterInput,
    sortBy: sortField,
    sortDir,
    page,
    pageSize,
  }

  const utils = trpc.useUtils()
  const list = trpc.gocardless.payments.list.useQuery(listInput, {
    placeholderData: (prev) => prev,
  })
  const counts = trpc.gocardless.payments.statusCounts.useQuery(filterInput)
  const filteredCustomer = trpc.gocardless.customers.detail.useQuery(
    { gcCustomerId: customerFilter ?? '' },
    { enabled: customerFilter !== null },
  )

  const [showNew, setShowNew] = useState(false)
  const [action, setAction] = useState<{
    kind: 'cancel' | 'retry' | 'refund'
    gcPaymentId: string
    label: string
    amountMinor?: number
    currency?: string
  } | null>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')

  const refresh = () => {
    void utils.gocardless.payments.list.invalidate()
    void utils.gocardless.payments.statusCounts.invalidate()
    void utils.gocardless.overview.invalidate()
  }

  const cancel = trpc.gocardless.payments.cancel.useMutation({
    onSuccess: () => {
      toast.success('Payment cancelled.')
      setAction(null)
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const retry = trpc.gocardless.payments.retry.useMutation({
    onSuccess: () => {
      toast.success('Payment retry submitted.')
      setAction(null)
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const refund = trpc.gocardless.payments.refund.useMutation({
    onSuccess: (res) => {
      toast.success(`Refund submitted (${res.gcRefundId}).`)
      setAction(null)
      setRefundAmount('')
      setRefundReason('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  const busy = cancel.isPending || retry.isPending || refund.isPending
  const items = list.data?.items ?? []
  const total = list.data?.total ?? 0

  const countFor = (value: StatusFilter): number | null => {
    if (!counts.data) return null
    if (value === 'all') return counts.data.total
    return counts.data.counts[value] ?? 0
  }
  const chipOptions = STATUS_OPTIONS.map((opt) => {
    const n = countFor(opt.value)
    return { value: opt.value, label: n === null ? opt.label : `${opt.label} (${n})` }
  })

  // CSV export honours the current filters + sort, paging up to the cap.
  const exportRows = async () => {
    const rows: Array<Record<string, unknown>> = []
    let exportPage = 1
    for (;;) {
      const res = await utils.gocardless.payments.list.fetch({
        ...listInput,
        page: exportPage,
        pageSize: 100,
      })
      for (const r of res.items) {
        rows.push({
          chargeDate: r.chargeDate ? new Date(r.chargeDate).toISOString().slice(0, 10) : '',
          customer: r.customer?.contactName ?? r.customer?.displayName ?? '',
          email: r.customer?.email ?? '',
          amount: (r.amountMinor / 100).toFixed(2),
          currency: r.currency,
          status: r.status,
          description: r.description ?? '',
          plan: r.gcSubscriptionId ?? '',
          gcPaymentId: r.gcPaymentId,
        })
      }
      if (rows.length >= Math.min(res.total, EXPORT_CAP) || res.items.length === 0) break
      exportPage += 1
    }
    return rows
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FilterChips
            options={chipOptions}
            value={status}
            onChange={(v) => set({ status: v === 'all' ? null : v })}
          />
          {customerFilter ? (
            <span className="flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800">
              {filteredCustomer.data?.customer.name ??
                filteredCustomer.data?.customer.email ??
                customerFilter}
              <button
                type="button"
                aria-label="Clear customer filter"
                className="ml-1 text-primary-500 hover:text-primary-800"
                onClick={() => set({ customer: null })}
              >
                ✕
              </button>
            </span>
          ) : null}
        </div>
        <Button size="sm" onClick={() => setShowNew((v) => !v)}>
          {showNew ? 'Close' : 'Collect a payment'}
        </Button>
      </div>

      {/* Filter + view toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {!customerFilter ? (
          <SearchField placeholder="Search by customer…" className="w-56" />
        ) : null}
        <span className="flex items-center gap-1 text-xs text-neutral-500">
          Charged
          <ParamInput param="from" type="date" label="Charge date from" width="w-34" />
          –
          <ParamInput param="to" type="date" label="Charge date to" width="w-34" />
        </span>
        <span className="flex items-center gap-1 text-xs text-neutral-500">
          £
          <ParamInput param="min" label="Minimum amount" placeholder="min" width="w-20" />
          –
          <ParamInput param="max" label="Maximum amount" placeholder="max" width="w-20" />
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SortMenu options={SORT_OPTIONS} defaultValue="chargeDate" />
          <PageSizeSelect defaultValue={50} options={[25, 50, 100]} />
          <CsvExportButton
            getRows={exportRows}
            columns={[
              { header: 'Charge date', value: (r) => String(r['chargeDate'] ?? '') },
              { header: 'Customer', value: (r) => String(r['customer'] ?? '') },
              { header: 'Email', value: (r) => String(r['email'] ?? '') },
              { header: 'Amount', value: (r) => String(r['amount'] ?? '') },
              { header: 'Currency', value: (r) => String(r['currency'] ?? '') },
              { header: 'Status', value: (r) => String(r['status'] ?? '') },
              { header: 'Description', value: (r) => String(r['description'] ?? '') },
              { header: 'Plan', value: (r) => String(r['plan'] ?? '') },
              { header: 'GoCardless id', value: (r) => String(r['gcPaymentId'] ?? '') },
            ]}
            fileNameBase="gocardless-payments"
          />
        </div>
      </div>

      {showNew ? (
        <CollectPaymentForm
          onDone={() => setShowNew(false)}
          prefillCustomer={
            customerFilter && filteredCustomer.data
              ? {
                  gcCustomerId: customerFilter,
                  label:
                    filteredCustomer.data.customer.name ??
                    filteredCustomer.data.customer.email ??
                    customerFilter,
                }
              : null
          }
        />
      ) : null}

      {action ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">
            {action.kind === 'cancel'
              ? 'Cancel this payment?'
              : action.kind === 'retry'
                ? 'Retry this payment?'
                : 'Refund this payment?'}
          </div>
          <p className="mt-1">
            {action.label} —{' '}
            {action.kind === 'cancel'
              ? 'it has not been submitted to the bank yet, so nothing will be collected.'
              : action.kind === 'retry'
                ? 'GoCardless will submit it to the bank again on the next working day.'
                : 'the money goes back to the customer\u2019s bank account. This cannot be undone.'}
          </p>
          {action.kind === 'refund' ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="dd-refund-amount">Amount to refund (GBP)</Label>
                <Input
                  id="dd-refund-amount"
                  inputMode="decimal"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  placeholder={
                    action.amountMinor !== undefined
                      ? (action.amountMinor / 100).toFixed(2)
                      : '0.00'
                  }
                />
                <p className="text-xs text-amber-800">
                  Up to{' '}
                  {action.amountMinor !== undefined
                    ? formatMoneyMinor(action.amountMinor, action.currency)
                    : 'the collected amount'}
                  .
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="dd-refund-reason">Reason</Label>
                <Input
                  id="dd-refund-reason"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="Why? Recorded in the audit log."
                />
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant={action.kind === 'retry' ? 'default' : 'destructive'}
              disabled={
                busy ||
                (action.kind === 'refund' &&
                  (gbpToMinor(refundAmount) === null ||
                    refundReason.trim().length < 2 ||
                    (action.amountMinor !== undefined &&
                      (gbpToMinor(refundAmount) ?? 0) > action.amountMinor)))
              }
              onClick={() => {
                if (action.kind === 'cancel') cancel.mutate({ gcPaymentId: action.gcPaymentId })
                else if (action.kind === 'retry') retry.mutate({ gcPaymentId: action.gcPaymentId })
                else {
                  const minor = gbpToMinor(refundAmount)
                  if (minor === null) return
                  refund.mutate({
                    gcPaymentId: action.gcPaymentId,
                    amountMinor: minor,
                    reason: refundReason.trim(),
                  })
                }
              }}
            >
              {busy ? 'Working…' : 'Confirm'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setAction(null)
                setRefundAmount('')
                setRefundReason('')
              }}
            >
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {list.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading payments…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">No payments match these filters.</p>
          <p className="mt-1 text-sm text-neutral-500">
            Adjust the filters above, or run the import to pull history.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
            <Table>
              <Thead>
                <Tr>
                  <Th>Customer</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Charge date</Th>
                  <Th>Description</Th>
                  <Th>Plan</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {items.map((p) => (
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
                    <Td className="max-w-[16rem] truncate text-neutral-600">
                      {p.description ?? '—'}
                    </Td>
                    <Td>
                      {p.gcSubscriptionId ? (
                        <code className="font-mono text-[11px] text-neutral-500">
                          {p.gcSubscriptionId}
                        </code>
                      ) : (
                        <span className="text-xs text-neutral-400">one-off</span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        {CANCELLABLE.has(p.status) ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-red-700"
                            onClick={() =>
                              setAction({
                                kind: 'cancel',
                                gcPaymentId: p.gcPaymentId,
                                label: `${formatMoneyMinor(p.amountMinor, p.currency)} from ${
                                  p.customer?.displayName ?? 'customer'
                                }`,
                              })
                            }
                          >
                            Cancel
                          </Button>
                        ) : null}
                        {p.status === 'failed' ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setAction({
                                kind: 'retry',
                                gcPaymentId: p.gcPaymentId,
                                label: `${formatMoneyMinor(p.amountMinor, p.currency)} from ${
                                  p.customer?.displayName ?? 'customer'
                                }`,
                              })
                            }
                          >
                            Retry
                          </Button>
                        ) : null}
                        {['confirmed', 'paid_out'].includes(p.status) ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-red-700"
                            onClick={() => {
                              setRefundAmount((p.amountMinor / 100).toFixed(2))
                              setAction({
                                kind: 'refund',
                                gcPaymentId: p.gcPaymentId,
                                amountMinor: p.amountMinor,
                                currency: p.currency,
                                label: `${formatMoneyMinor(p.amountMinor, p.currency)} from ${
                                  p.customer?.displayName ?? 'customer'
                                }`,
                              })
                            }}
                          >
                            Refund
                          </Button>
                        ) : null}
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
              Filtered value:{' '}
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

function gbpToMinor(v: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(v.trim())) return null
  const minor = Math.round(Number(v.trim()) * 100)
  return Number.isFinite(minor) && minor > 0 ? minor : null
}

function CollectPaymentForm({
  onDone,
  prefillCustomer = null,
}: {
  onDone: () => void
  prefillCustomer?: { gcCustomerId: string; label: string } | null
}) {
  const utils = trpc.useUtils()
  const [mandate, setMandate] = useState<PickedMandate | null>(null)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [chargeDate, setChargeDate] = useState('')
  const [confirming, setConfirming] = useState(false)

  const create = trpc.gocardless.payments.create.useMutation({
    onSuccess: (res) => {
      toast.success(`Payment queued (${statusLabel(res.status)}).`)
      void utils.gocardless.payments.list.invalidate()
      void utils.gocardless.payments.statusCounts.invalidate()
      void utils.gocardless.overview.invalidate()
      onDone()
    },
    onError: (e) => {
      toast.error(e.message)
      setConfirming(false)
    },
  })

  const minor = gbpToMinor(amount)
  const valid = mandate !== null && minor !== null

  if (confirming && mandate && minor) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <div className="font-semibold">Confirm one-off Direct Debit collection</div>
        <ul className="mt-2 space-y-1">
          <li>Customer: {mandate.customerLabel}</li>
          <li>Amount: {formatMoneyMinor(minor)}</li>
          {description ? <li>Description: {description}</li> : null}
          <li>Charge date: {chargeDate || 'next available'}</li>
        </ul>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={create.isPending}
            onClick={() =>
              create.mutate({
                gcMandateId: mandate.gcMandateId,
                amountMinor: minor,
                ...(description.trim().length >= 2 ? { description: description.trim() } : {}),
                ...(chargeDate ? { chargeDate } : {}),
              })
            }
          >
            {create.isPending ? 'Collecting…' : 'Collect payment'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={create.isPending}
            onClick={() => setConfirming(false)}
          >
            Back
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
      <div className="space-y-1.5">
        <Label>Customer &amp; mandate</Label>
        <CustomerMandatePicker
          value={mandate}
          onChange={setMandate}
          initialCustomer={prefillCustomer}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="pay-amount">Amount (GBP)</Label>
          <Input
            id="pay-amount"
            inputMode="decimal"
            placeholder="120.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pay-desc">Description</Label>
          <Input
            id="pay-desc"
            placeholder="e.g. October tuition top-up"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pay-date">Charge date (optional)</Label>
          <Input
            id="pay-date"
            type="date"
            min={new Date().toISOString().slice(0, 10)}
            value={chargeDate}
            onChange={(e) => setChargeDate(e.target.value)}
          />
        </div>
      </div>
      <Button size="sm" disabled={!valid} onClick={() => setConfirming(true)}>
        Review payment
      </Button>
    </div>
  )
}
