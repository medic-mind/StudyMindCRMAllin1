'use client'

// GoCardless payments tab (ADR 0038): the complete payment mirror, with
// human-confirmed collect / cancel / retry actions (CLAUDE.md §3).

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import {
  CustomerMandatePicker,
  FilterChips,
  formatDate,
  PAYMENT_TONE,
  statusLabel,
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

const CANCELLABLE = new Set(['pending_customer_approval', 'pending_submission'])

export function PaymentsTab() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // ?customer=CU… filters the whole tab to one customer (set by the customer
  // record's deep links — same pattern as the GoCardless dashboard).
  const customerFilter = searchParams.get('customer')

  const [status, setStatus] = useState<StatusFilter>('all')
  const [showNew, setShowNew] = useState(false)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [action, setAction] = useState<{
    kind: 'cancel' | 'retry'
    gcPaymentId: string
    label: string
  } | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const filterInput = {
    ...(customerFilter ? { gcCustomerId: customerFilter } : {}),
    ...(!customerFilter && debouncedQ.trim().length >= 2 ? { q: debouncedQ.trim() } : {}),
  }

  const utils = trpc.useUtils()
  const list = trpc.gocardless.payments.list.useQuery({ status, ...filterInput })
  const counts = trpc.gocardless.payments.statusCounts.useQuery(filterInput)
  const filteredCustomer = trpc.gocardless.customers.detail.useQuery(
    { gcCustomerId: customerFilter ?? '' },
    { enabled: customerFilter !== null },
  )

  const clearCustomerFilter = () => router.replace('/direct-debits/payments', { scroll: false })

  const refresh = () => {
    void utils.gocardless.payments.list.invalidate()
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

  const busy = cancel.isPending || retry.isPending
  const items = list.data?.items ?? []

  const countFor = (value: StatusFilter): number | null => {
    if (!counts.data) return null
    if (value === 'all') return counts.data.total
    return counts.data.counts[value] ?? 0
  }
  const chipOptions = STATUS_OPTIONS.map((opt) => {
    const n = countFor(opt.value)
    return { value: opt.value, label: n === null ? opt.label : `${opt.label} (${n})` }
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FilterChips options={chipOptions} value={status} onChange={setStatus} />
          {customerFilter ? (
            <span className="flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800">
              {filteredCustomer.data?.customer.name ??
                filteredCustomer.data?.customer.email ??
                customerFilter}
              <button
                type="button"
                aria-label="Clear customer filter"
                className="ml-1 text-primary-500 hover:text-primary-800"
                onClick={clearCustomerFilter}
              >
                ✕
              </button>
            </span>
          ) : (
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by customer…"
              className="h-8 w-56"
            />
          )}
        </div>
        <Button size="sm" onClick={() => setShowNew((v) => !v)}>
          {showNew ? 'Close' : 'Collect a payment'}
        </Button>
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
            {action.kind === 'cancel' ? 'Cancel this payment?' : 'Retry this payment?'}
          </div>
          <p className="mt-1">
            {action.label} —{' '}
            {action.kind === 'cancel'
              ? 'it has not been submitted to the bank yet, so nothing will be collected.'
              : 'GoCardless will submit it to the bank again on the next working day.'}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant={action.kind === 'cancel' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() => {
                if (action.kind === 'cancel') cancel.mutate({ gcPaymentId: action.gcPaymentId })
                else retry.mutate({ gcPaymentId: action.gcPaymentId })
              }}
            >
              {busy ? 'Working…' : 'Confirm'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAction(null)}>
              Back
            </Button>
          </div>
        </div>
      ) : null}

      {list.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading payments…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">No payments to show.</p>
          <p className="mt-1 text-sm text-neutral-500">
            Payments land here live from GoCardless webhooks; run the import to pull history.
          </p>
        </div>
      ) : (
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
