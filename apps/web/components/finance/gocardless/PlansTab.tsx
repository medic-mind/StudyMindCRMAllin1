'use client'

// Direct Debit plans (GoCardless subscriptions) — ADR 0038. Every status is
// visible, past plans included, with the proper list system: status tabs
// with live counts, customer search, cadence + amount filters, whitelisted
// sorting, paging with totals, and CSV export. List state lives in the URL
// (CLAUDE.md §26). Create / cancel / pause / resume stay human-confirmed (§3).

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
  ParamInput,
  readPageSort,
  readPoundsParam,
  statusLabel,
  SUBSCRIPTION_TONE,
  useListParams,
  type PickedMandate,
} from './shared'

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'pending_customer_approval', label: 'Pending approval' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'finished', label: 'Finished' },
  { value: 'all', label: 'All' },
] as const

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value']

const SORT_FIELDS = [
  'createdAt',
  'gcCreatedAt',
  'amountMinor',
  'nextChargeAt',
  'startDate',
  'name',
] as const
type SortField = (typeof SORT_FIELDS)[number]

const SORT_OPTIONS = [
  { value: 'createdAt', label: 'Imported' },
  { value: 'gcCreatedAt', label: 'Created (GoCardless)' },
  { value: 'amountMinor', label: 'Amount' },
  { value: 'nextChargeAt', label: 'Next charge', defaultDir: 'asc' as const },
  { value: 'startDate', label: 'Start date' },
  { value: 'name', label: 'Plan name', defaultDir: 'asc' as const },
]

const INTERVAL_OPTIONS = [
  { value: 'all', label: 'Any cadence' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
] as const

const EXPORT_CAP = 5000

function cadence(item: {
  intervalUnit: string
  interval: number
  dayOfMonth: number | null
}): string {
  const base =
    item.interval === 1
      ? item.intervalUnit === 'weekly'
        ? 'week'
        : item.intervalUnit === 'monthly'
          ? 'month'
          : 'year'
      : `${item.interval} ${item.intervalUnit.replace('ly', 's')}`
  const day =
    item.dayOfMonth === null ? '' : item.dayOfMonth === -1 ? ' (last day)' : ` (day ${item.dayOfMonth})`
  return `every ${base}${day}`
}

export function PlansTab() {
  const { get, set } = useListParams()

  const customerFilter = get('customer') || null
  const statusRaw = get('status', 'active')
  const status: StatusFilter = STATUS_OPTIONS.some((o) => o.value === statusRaw)
    ? (statusRaw as StatusFilter)
    : 'active'
  const q = get('q').trim()
  const intervalRaw = get('cadence', 'all')
  const intervalUnit: 'weekly' | 'monthly' | 'yearly' | undefined =
    intervalRaw === 'weekly' || intervalRaw === 'monthly' || intervalRaw === 'yearly'
      ? intervalRaw
      : undefined
  const { page, pageSize, sortBy, sortDir } = readPageSort(get, { sortBy: 'createdAt' })
  const sortField: SortField = SORT_FIELDS.includes(sortBy as SortField)
    ? (sortBy as SortField)
    : 'createdAt'

  const filterInput = {
    ...(customerFilter ? { gcCustomerId: customerFilter } : {}),
    ...(!customerFilter && q.length >= 2 ? { q } : {}),
    ...(intervalUnit ? { intervalUnit } : {}),
    ...(readPoundsParam(get('min')) !== undefined
      ? { amountMinMinor: readPoundsParam(get('min')) }
      : {}),
    ...(readPoundsParam(get('max')) !== undefined
      ? { amountMaxMinor: readPoundsParam(get('max')) }
      : {}),
  }
  const listInput = { status, ...filterInput, sortBy: sortField, sortDir, page, pageSize }

  const utils = trpc.useUtils()
  const list = trpc.gocardless.subscriptions.list.useQuery(listInput, {
    placeholderData: (prev) => prev,
  })
  const counts = trpc.gocardless.subscriptions.statusCounts.useQuery(filterInput)
  const filteredCustomer = trpc.gocardless.customers.detail.useQuery(
    { gcCustomerId: customerFilter ?? '' },
    { enabled: customerFilter !== null },
  )

  const [showNew, setShowNew] = useState(false)
  const [action, setAction] = useState<{
    kind: 'cancel' | 'pause' | 'resume' | 'edit'
    gcSubscriptionId: string
    label: string
    /** Current values, prefilled into the edit panel. */
    currentAmountMinor?: number
    currentName?: string | null
  } | null>(null)
  const [reason, setReason] = useState('')
  const [pauseCycles, setPauseCycles] = useState('')
  const [editAmount, setEditAmount] = useState('')
  const [editName, setEditName] = useState('')

  const refresh = () => {
    void utils.gocardless.subscriptions.list.invalidate()
    void utils.gocardless.subscriptions.statusCounts.invalidate()
    void utils.gocardless.overview.invalidate()
  }

  const cancel = trpc.gocardless.subscriptions.cancel.useMutation({
    onSuccess: () => {
      toast.success('Plan cancelled.')
      setAction(null)
      setReason('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const pause = trpc.gocardless.subscriptions.pause.useMutation({
    onSuccess: () => {
      toast.success('Plan paused.')
      setAction(null)
      setReason('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const resume = trpc.gocardless.subscriptions.resume.useMutation({
    onSuccess: () => {
      toast.success('Plan resumed.')
      setAction(null)
      setReason('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const update = trpc.gocardless.subscriptions.update.useMutation({
    onSuccess: () => {
      toast.success('Plan amended — GoCardless notifies the customer of the change.')
      setAction(null)
      setReason('')
      setEditAmount('')
      setEditName('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  const busy = cancel.isPending || pause.isPending || resume.isPending || update.isPending
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

  const exportRows = async () => {
    const rows: Array<Record<string, unknown>> = []
    let exportPage = 1
    for (;;) {
      const res = await utils.gocardless.subscriptions.list.fetch({
        ...listInput,
        page: exportPage,
        pageSize: 100,
      })
      for (const r of res.items) {
        rows.push({
          customer: r.customer?.contactName ?? r.customer?.displayName ?? '',
          email: r.customer?.email ?? '',
          plan: r.name ?? '',
          amount: (r.amountMinor / 100).toFixed(2),
          cadence: cadence(r),
          status: r.status,
          nextCharge: r.nextChargeAt ? new Date(r.nextChargeAt).toISOString().slice(0, 10) : '',
          started: r.startDate ? new Date(r.startDate).toISOString().slice(0, 10) : '',
          gcSubscriptionId: r.gcSubscriptionId,
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
            onChange={(v) => set({ status: v === 'active' ? null : v })}
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
          {showNew ? 'Close' : 'New plan'}
        </Button>
      </div>

      {/* Filter + view toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {!customerFilter ? (
          <SearchField placeholder="Search by customer…" className="w-56" />
        ) : null}
        <select
          value={intervalRaw}
          onChange={(e) => set({ cadence: e.target.value === 'all' ? null : e.target.value })}
          aria-label="Cadence"
          className="h-8 rounded-md border border-neutral-300 bg-white px-2 text-xs"
        >
          {INTERVAL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="flex items-center gap-1 text-xs text-neutral-500">
          £
          <ParamInput param="min" label="Minimum amount" placeholder="min" width="w-20" />
          –
          <ParamInput param="max" label="Maximum amount" placeholder="max" width="w-20" />
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SortMenu options={SORT_OPTIONS} defaultValue="createdAt" />
          <PageSizeSelect defaultValue={50} options={[25, 50, 100]} />
          <CsvExportButton
            getRows={exportRows}
            columns={[
              { header: 'Customer', value: (r) => String(r['customer'] ?? '') },
              { header: 'Email', value: (r) => String(r['email'] ?? '') },
              { header: 'Plan', value: (r) => String(r['plan'] ?? '') },
              { header: 'Amount', value: (r) => String(r['amount'] ?? '') },
              { header: 'Cadence', value: (r) => String(r['cadence'] ?? '') },
              { header: 'Status', value: (r) => String(r['status'] ?? '') },
              { header: 'Next charge', value: (r) => String(r['nextCharge'] ?? '') },
              { header: 'Started', value: (r) => String(r['started'] ?? '') },
              { header: 'GoCardless id', value: (r) => String(r['gcSubscriptionId'] ?? '') },
            ]}
            fileNameBase="gocardless-plans"
          />
        </div>
      </div>

      {showNew ? (
        <NewPlanForm
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
              ? 'Cancel this plan?'
              : action.kind === 'pause'
                ? 'Pause this plan?'
                : action.kind === 'edit'
                  ? 'Amend this plan'
                  : 'Resume this plan?'}
          </div>
          <p className="mt-1">
            {action.label} —{' '}
            {action.kind === 'cancel'
              ? 'no further payments will be collected. This cannot be undone (a new plan would be needed).'
              : action.kind === 'pause'
                ? 'collections stop until the plan is resumed (or auto-resume after the cycles below).'
                : action.kind === 'edit'
                  ? 'change the amount and/or name in place — the schedule keeps running and GoCardless notifies the customer.'
                  : 'collections start again on the next charge date.'}
          </p>
          {action.kind === 'edit' ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="dd-edit-amount">New amount (GBP)</Label>
                <Input
                  id="dd-edit-amount"
                  inputMode="decimal"
                  value={editAmount}
                  onChange={(e) => setEditAmount(e.target.value)}
                  placeholder={
                    action.currentAmountMinor !== undefined
                      ? (action.currentAmountMinor / 100).toFixed(2)
                      : '40.00'
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dd-edit-name">New plan name</Label>
                <Input
                  id="dd-edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={action.currentName ?? 'leave blank to keep'}
                />
              </div>
            </div>
          ) : null}
          {action.kind === 'pause' ? (
            <div className="mt-2 space-y-1">
              <Label htmlFor="dd-pause-cycles">Auto-resume after (collections skipped, optional)</Label>
              <Input
                id="dd-pause-cycles"
                inputMode="numeric"
                value={pauseCycles}
                onChange={(e) => setPauseCycles(e.target.value)}
                placeholder="Leave blank to pause until manually resumed"
              />
            </div>
          ) : null}
          {action.kind !== 'resume' ? (
            <div className="mt-2 space-y-1">
              <Label htmlFor="dd-action-reason">Reason</Label>
              <Input
                id="dd-action-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why? Recorded in the audit log."
              />
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant={action.kind === 'cancel' ? 'destructive' : 'default'}
              disabled={
                busy ||
                (action.kind !== 'resume' && reason.trim().length < 2) ||
                (action.kind === 'edit' &&
                  gbpToMinor(editAmount) === null &&
                  editName.trim().length < 2)
              }
              onClick={() => {
                if (action.kind === 'edit') {
                  const newMinor = gbpToMinor(editAmount)
                  update.mutate({
                    gcSubscriptionId: action.gcSubscriptionId,
                    ...(newMinor !== null ? { amountMinor: newMinor } : {}),
                    ...(editName.trim().length >= 2 ? { name: editName.trim() } : {}),
                    ...(reason.trim().length >= 2 ? { reason: reason.trim() } : {}),
                  })
                  return
                }
                const cyclesNum = Number(pauseCycles.trim())
                const input = {
                  gcSubscriptionId: action.gcSubscriptionId,
                  ...(reason.trim().length >= 2 ? { reason: reason.trim() } : {}),
                }
                if (action.kind === 'cancel') cancel.mutate(input)
                else if (action.kind === 'pause')
                  pause.mutate({
                    ...input,
                    ...(Number.isInteger(cyclesNum) && cyclesNum >= 1 && cyclesNum <= 52
                      ? { pauseCycles: cyclesNum }
                      : {}),
                  })
                else resume.mutate(input)
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
                setReason('')
                setPauseCycles('')
                setEditAmount('')
                setEditName('')
              }}
            >
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {list.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading plans…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">No plans match these filters.</p>
          <p className="mt-1 text-sm text-neutral-500">
            Adjust the filters above, create one with “New plan”, or run the import to pull the
            full history.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
            <Table>
              <Thead>
                <Tr>
                  <Th>Customer</Th>
                  <Th>Plan</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Schedule</Th>
                  <Th>Next charge</Th>
                  <Th>Started</Th>
                  <Th>Status</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {items.map((s) => (
                  <Tr key={s.gcSubscriptionId}>
                    <Td>
                      {s.customer?.contactId ? (
                        <Link
                          href={`/contacts/${s.customer.contactId}`}
                          className="font-medium text-primary-700 hover:underline"
                        >
                          {s.customer.contactName ?? s.customer.displayName}
                        </Link>
                      ) : s.customer ? (
                        <Link
                          href={`/direct-debits/customers/${encodeURIComponent(s.customer.gcCustomerId)}`}
                          className="font-medium text-neutral-700 hover:text-primary-700 hover:underline"
                        >
                          {s.customer.displayName}
                        </Link>
                      ) : (
                        <span className="text-neutral-700">—</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-neutral-900">{s.name ?? '—'}</span>{' '}
                      <code className="font-mono text-[11px] text-neutral-400">
                        {s.gcSubscriptionId}
                      </code>
                    </Td>
                    <Td className="text-right font-mono tabular-nums">
                      {formatMoneyMinor(s.amountMinor, s.currency)}
                    </Td>
                    <Td className="text-neutral-600">{cadence(s)}</Td>
                    <Td className="text-neutral-600">
                      {s.nextChargeAt
                        ? `${formatDate(s.nextChargeAt)}${
                            s.nextChargeMinor
                              ? ` · ${formatMoneyMinor(s.nextChargeMinor, s.currency)}`
                              : ''
                          }`
                        : '—'}
                    </Td>
                    <Td className="text-neutral-600">
                      {formatDate(s.startDate ?? s.gcCreatedAt)}
                    </Td>
                    <Td>
                      <Badge tone={SUBSCRIPTION_TONE[s.status] ?? 'neutral'} dot>
                        {statusLabel(s.status)}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        {['active', 'paused'].includes(s.status) ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setAction({
                                kind: 'edit',
                                gcSubscriptionId: s.gcSubscriptionId,
                                label: s.name ?? s.gcSubscriptionId,
                                currentAmountMinor: s.amountMinor,
                                currentName: s.name ?? null,
                              })
                            }
                          >
                            Edit
                          </Button>
                        ) : null}
                        {s.status === 'active' ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setAction({
                                kind: 'pause',
                                gcSubscriptionId: s.gcSubscriptionId,
                                label: s.name ?? s.gcSubscriptionId,
                              })
                            }
                          >
                            Pause
                          </Button>
                        ) : null}
                        {s.status === 'paused' ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setAction({
                                kind: 'resume',
                                gcSubscriptionId: s.gcSubscriptionId,
                                label: s.name ?? s.gcSubscriptionId,
                              })
                            }
                          >
                            Resume
                          </Button>
                        ) : null}
                        {['active', 'paused', 'pending_customer_approval'].includes(s.status) ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-red-700"
                            onClick={() =>
                              setAction({
                                kind: 'cancel',
                                gcSubscriptionId: s.gcSubscriptionId,
                                label: s.name ?? s.gcSubscriptionId,
                              })
                            }
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
          <PaginationBar page={page} pageSize={pageSize} total={total} shown={items.length} />
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

function NewPlanForm({
  onDone,
  prefillCustomer = null,
}: {
  onDone: () => void
  prefillCustomer?: { gcCustomerId: string; label: string } | null
}) {
  const utils = trpc.useUtils()
  const [mandate, setMandate] = useState<PickedMandate | null>(null)
  const [amount, setAmount] = useState('')
  const [intervalUnit, setIntervalUnit] = useState<'weekly' | 'monthly' | 'yearly'>('monthly')
  const [intervalEvery, setIntervalEvery] = useState('1')
  const [dayOfMonth, setDayOfMonth] = useState('')
  const [month, setMonth] = useState('')
  const [count, setCount] = useState('')
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [confirming, setConfirming] = useState(false)
  const todayIso = new Date().toISOString().slice(0, 10)

  const create = trpc.gocardless.subscriptions.create.useMutation({
    onSuccess: (res) => {
      toast.success(`Plan created (${statusLabel(res.status)}).`)
      void utils.gocardless.subscriptions.list.invalidate()
      void utils.gocardless.subscriptions.statusCounts.invalidate()
      void utils.gocardless.overview.invalidate()
      onDone()
    },
    onError: (e) => {
      toast.error(e.message)
      setConfirming(false)
    },
  })

  const minor = gbpToMinor(amount)
  const intervalNum = Number(intervalEvery)
  const intervalValid = Number.isInteger(intervalNum) && intervalNum >= 1 && intervalNum <= 12
  const countNum = count.trim() === '' ? null : Number(count.trim())
  const countValid =
    countNum === null || (Number.isInteger(countNum) && countNum >= 1 && countNum <= 520)
  const valid = mandate !== null && minor !== null && intervalValid && countValid

  if (confirming && mandate && minor) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <div className="font-semibold">Confirm new Direct Debit plan</div>
        <ul className="mt-2 space-y-1">
          <li>Customer: {mandate.customerLabel}</li>
          <li>
            Amount: {formatMoneyMinor(minor)}{' '}
            {intervalNum === 1
              ? intervalUnit
              : `every ${intervalNum} ${intervalUnit.replace('ly', 's')}`}
            {dayOfMonth ? ` (day ${dayOfMonth === '-1' ? 'last' : dayOfMonth})` : ''}
            {intervalUnit === 'yearly' && month ? ` (month ${month})` : ''}
          </li>
          {countNum !== null ? (
            <li>
              Fixed length: {countNum} collection{countNum === 1 ? '' : 's'} (total{' '}
              {formatMoneyMinor(minor * countNum)}) — then the plan finishes itself.
            </li>
          ) : (
            <li>Open-ended — collects until cancelled.</li>
          )}
          {name ? <li>Name: {name}</li> : null}
          {startDate ? <li>First charge on/after: {startDate}</li> : null}
        </ul>
        <p className="mt-2 text-xs">
          GoCardless notifies the customer before each collection. The plan appears in the
          customer’s timeline.
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={create.isPending}
            onClick={() =>
              create.mutate({
                gcMandateId: mandate.gcMandateId,
                amountMinor: minor,
                intervalUnit,
                interval: intervalValid ? intervalNum : 1,
                ...(dayOfMonth ? { dayOfMonth: Number(dayOfMonth) } : {}),
                ...(intervalUnit === 'yearly' && month ? { month: Number(month) } : {}),
                ...(countNum !== null ? { count: countNum } : {}),
                ...(name.trim().length >= 2 ? { name: name.trim() } : {}),
                ...(startDate ? { startDate } : {}),
              })
            }
          >
            {create.isPending ? 'Creating…' : 'Create plan'}
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="plan-amount">Amount (GBP)</Label>
          <Input
            id="plan-amount"
            inputMode="decimal"
            placeholder="40.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plan-interval">Collect</Label>
          <div className="flex gap-1.5">
            <select
              id="plan-interval-every"
              aria-label="Every how many periods"
              className="h-9 w-20 rounded-md border border-neutral-300 bg-white px-2 text-sm"
              value={intervalEvery}
              onChange={(e) => setIntervalEvery(e.target.value)}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={String(n)}>
                  {n === 1 ? 'Every' : `Every ${n}`}
                </option>
              ))}
            </select>
            <select
              id="plan-interval"
              className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm"
              value={intervalUnit}
              onChange={(e) => setIntervalUnit(e.target.value as typeof intervalUnit)}
            >
              <option value="weekly">{intervalNum === 1 ? 'Week' : 'Weeks'}</option>
              <option value="monthly">{intervalNum === 1 ? 'Month' : 'Months'}</option>
              <option value="yearly">{intervalNum === 1 ? 'Year' : 'Years'}</option>
            </select>
          </div>
        </div>
        {intervalUnit === 'yearly' ? (
          <div className="space-y-1.5">
            <Label htmlFor="plan-month">Month</Label>
            <select
              id="plan-month"
              className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              <option value="">Next available</option>
              {[
                'January','February','March','April','May','June',
                'July','August','September','October','November','December',
              ].map((m, i) => (
                <option key={m} value={String(i + 1)}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {intervalUnit === 'monthly' ? (
          <div className="space-y-1.5">
            <Label htmlFor="plan-day">Day of month</Label>
            <select
              id="plan-day"
              className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm"
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
            >
              <option value="">Next available</option>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={String(d)}>
                  {d}
                </option>
              ))}
              <option value="-1">Last day</option>
            </select>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="plan-start">First charge (optional)</Label>
          <Input
            id="plan-start"
            type="date"
            min={todayIso}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plan-count">Number of collections (optional)</Label>
          <Input
            id="plan-count"
            inputMode="numeric"
            placeholder="Blank = ongoing"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="plan-name">Plan name (shows on the customer’s notifications)</Label>
        <Input
          id="plan-name"
          placeholder="e.g. Weekly tuition — 2 hours"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <Button size="sm" disabled={!valid} onClick={() => setConfirming(true)}>
        Review plan
      </Button>
    </div>
  )
}
