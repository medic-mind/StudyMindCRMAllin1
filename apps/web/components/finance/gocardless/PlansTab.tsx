'use client'

// Direct Debit plans (GoCardless subscriptions) — ADR 0038. Every status is
// visible, past plans included. Create / cancel / pause / resume are all
// human-confirmed (CLAUDE.md §3) and audited server-side.

import Link from 'next/link'
import { useState } from 'react'
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
  statusLabel,
  SUBSCRIPTION_TONE,
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

function cadence(item: {
  intervalUnit: string
  interval: number
  dayOfMonth: number | null
}): string {
  const unit =
    item.interval === 1
      ? item.intervalUnit.replace(/ly$/, item.intervalUnit === 'weekly' ? 'week' : '')
      : `${item.interval} ${item.intervalUnit.replace('ly', 's')}`
  const base =
    item.interval === 1
      ? item.intervalUnit === 'weekly'
        ? 'week'
        : item.intervalUnit === 'monthly'
          ? 'month'
          : 'year'
      : unit
  const day =
    item.dayOfMonth === null ? '' : item.dayOfMonth === -1 ? ' (last day)' : ` (day ${item.dayOfMonth})`
  return `every ${base}${day}`
}

export function PlansTab() {
  const [status, setStatus] = useState<StatusFilter>('active')
  const [showNew, setShowNew] = useState(false)
  const [action, setAction] = useState<{
    kind: 'cancel' | 'pause' | 'resume'
    gcSubscriptionId: string
    label: string
  } | null>(null)
  const [reason, setReason] = useState('')

  const utils = trpc.useUtils()
  const list = trpc.gocardless.subscriptions.list.useQuery({ status })

  const refresh = () => {
    void utils.gocardless.subscriptions.list.invalidate()
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

  const busy = cancel.isPending || pause.isPending || resume.isPending
  const items = list.data?.items ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterChips options={STATUS_OPTIONS} value={status} onChange={setStatus} />
        <Button size="sm" onClick={() => setShowNew((v) => !v)}>
          {showNew ? 'Close' : 'New plan'}
        </Button>
      </div>

      {showNew ? <NewPlanForm onDone={() => setShowNew(false)} /> : null}

      {action ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">
            {action.kind === 'cancel'
              ? 'Cancel this plan?'
              : action.kind === 'pause'
                ? 'Pause this plan?'
                : 'Resume this plan?'}
          </div>
          <p className="mt-1">
            {action.label} —{' '}
            {action.kind === 'cancel'
              ? 'no further payments will be collected. This cannot be undone (a new plan would be needed).'
              : action.kind === 'pause'
                ? 'collections stop until the plan is resumed.'
                : 'collections start again on the next charge date.'}
          </p>
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
              disabled={busy || (action.kind !== 'resume' && reason.trim().length < 2)}
              onClick={() => {
                const input = {
                  gcSubscriptionId: action.gcSubscriptionId,
                  ...(reason.trim().length >= 2 ? { reason: reason.trim() } : {}),
                }
                if (action.kind === 'cancel') cancel.mutate(input)
                else if (action.kind === 'pause') pause.mutate(input)
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
          <p className="text-sm font-medium text-neutral-700">
            No {status === 'all' ? '' : `${statusLabel(status)} `}plans yet.
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            Create one with “New plan”, or run the GoCardless import to pull the full history.
          </p>
        </div>
      ) : (
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
                    ) : (
                      <span className="text-neutral-700">
                        {s.customer?.displayName ?? '—'}
                      </span>
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
                  <Td className="text-neutral-600">{formatDate(s.startDate ?? s.gcCreatedAt)}</Td>
                  <Td>
                    <Badge tone={SUBSCRIPTION_TONE[s.status] ?? 'neutral'} dot>
                      {statusLabel(s.status)}
                    </Badge>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
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
      )}
    </div>
  )
}

function gbpToMinor(v: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(v.trim())) return null
  const minor = Math.round(Number(v.trim()) * 100)
  return Number.isFinite(minor) && minor > 0 ? minor : null
}

function NewPlanForm({ onDone }: { onDone: () => void }) {
  const utils = trpc.useUtils()
  const [mandate, setMandate] = useState<PickedMandate | null>(null)
  const [amount, setAmount] = useState('')
  const [intervalUnit, setIntervalUnit] = useState<'weekly' | 'monthly' | 'yearly'>('monthly')
  const [dayOfMonth, setDayOfMonth] = useState('')
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [confirming, setConfirming] = useState(false)

  const create = trpc.gocardless.subscriptions.create.useMutation({
    onSuccess: (res) => {
      toast.success(`Plan created (${statusLabel(res.status)}).`)
      void utils.gocardless.subscriptions.list.invalidate()
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
        <div className="font-semibold">Confirm new Direct Debit plan</div>
        <ul className="mt-2 space-y-1">
          <li>Customer: {mandate.customerLabel}</li>
          <li>
            Amount: {formatMoneyMinor(minor)} {intervalUnit}
            {dayOfMonth ? ` (day ${dayOfMonth === '-1' ? 'last' : dayOfMonth})` : ''}
          </li>
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
                interval: 1,
                ...(dayOfMonth ? { dayOfMonth: Number(dayOfMonth) } : {}),
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
        <CustomerMandatePicker value={mandate} onChange={setMandate} />
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
          <select
            id="plan-interval"
            className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm"
            value={intervalUnit}
            onChange={(e) => setIntervalUnit(e.target.value as typeof intervalUnit)}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
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
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
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
