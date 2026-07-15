'use client'

// The Family page's Direct Debit panel (ADR 0038). The Family is the billing
// unit (CLAUDE.md §6.1), so it gets the same at-a-glance GoCardless picture the
// contact panel shows — customers, mandates, plans (with the "still due"
// shortfall badge on plans ended early), and recent collections. Read-only;
// money actions live in /direct-debits.

import Link from 'next/link'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

function mandateTone(state: string): BadgeTone {
  if (state === 'active') return 'success'
  if (state === 'failed' || state === 'cancelled' || state === 'expired') return 'danger'
  return 'info'
}

function planTone(status: string): BadgeTone {
  if (status === 'active') return 'success'
  if (status === 'paused') return 'warn'
  if (status === 'cancelled') return 'danger'
  return 'neutral'
}

function paymentTone(status: string): BadgeTone {
  if (status === 'confirmed' || status === 'paid_out') return 'success'
  if (status === 'failed' || status === 'charged_back') return 'danger'
  if (status === 'cancelled') return 'neutral'
  return 'info'
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '—'
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(d))
}

function describeSchedule(s: {
  intervalUnit: string
  interval: number
  dayOfMonth: number | null
}): string {
  const unit =
    s.interval > 1
      ? `every ${s.interval} ${s.intervalUnit === 'weekly' ? 'weeks' : s.intervalUnit === 'yearly' ? 'years' : 'months'}`
      : s.intervalUnit === 'weekly'
        ? 'weekly'
        : s.intervalUnit === 'yearly'
          ? 'yearly'
          : 'monthly'
  return s.dayOfMonth ? `${unit} · day ${s.dayOfMonth}` : unit
}

export function FamilyDirectDebitPanel({ familyId }: { familyId: string }) {
  const summary = trpc.gocardless.familySummary.useQuery({ familyId })

  if (summary.isLoading) {
    return <p className="p-4 text-sm text-neutral-500">Loading Direct Debit details…</p>
  }
  const data = summary.data
  if (!data || data.customers.length === 0) {
    return (
      <p className="p-4 text-sm text-neutral-600">
        No GoCardless customer linked to this family yet.
      </p>
    )
  }

  const activeMandates = data.mandates.filter((m) => m.state === 'active')
  const firstCustomer = data.customers[0] ?? null

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {activeMandates.length > 0 ? (
            <Badge tone="success" dot>
              Direct Debit active
            </Badge>
          ) : data.mandates.length > 0 ? (
            <Badge tone="warn" dot>
              Mandate not active
            </Badge>
          ) : (
            <Badge tone="neutral">No active mandate</Badge>
          )}
          {firstCustomer ? (
            <span className="text-xs text-neutral-500">
              GoCardless: {firstCustomer.name ?? firstCustomer.email ?? firstCustomer.gcCustomerId}
            </span>
          ) : null}
        </div>
        {firstCustomer ? (
          <Link
            href={`/direct-debits/customers/${firstCustomer.gcCustomerId}`}
            className="text-xs font-medium text-primary-700 hover:underline"
          >
            Open in Direct Debits →
          </Link>
        ) : null}
      </div>

      {/* Plans */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Plans (subscriptions)
        </p>
        {data.subscriptions.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">No plans yet.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {data.subscriptions.map((s) => (
              <li
                key={s.gcSubscriptionId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm"
              >
                <Badge tone={planTone(s.status)}>{s.status.replaceAll('_', ' ')}</Badge>
                <span className="font-medium text-neutral-800">
                  {formatMoneyMinor(s.amountMinor, s.currency)}
                </span>
                <span className="text-xs text-neutral-500">{describeSchedule(s)}</span>
                {s.totalPaymentCount ? (
                  <span className="text-xs text-neutral-500">
                    · {s.totalPaymentCount}-payment plan · total{' '}
                    {formatMoneyMinor(s.amountMinor * s.totalPaymentCount, s.currency)}
                  </span>
                ) : null}
                {typeof s.shortfallMinor === 'number' && s.shortfallMinor > 0 ? (
                  <Badge tone="danger">
                    {formatMoneyMinor(s.shortfallMinor, s.currency)} still due
                  </Badge>
                ) : null}
                {s.caseStatus && s.caseStatus !== 'new' ? (
                  <Badge tone={s.caseStatus === 'recovered' ? 'success' : 'info'}>
                    {s.caseStatus.replaceAll('_', ' ')}
                  </Badge>
                ) : null}
                {s.name ? <span className="text-xs text-neutral-500">· {s.name}</span> : null}
                {s.nextChargeAt ? (
                  <span className="ml-auto text-xs text-neutral-500">
                    next {formatDate(s.nextChargeAt)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Mandates */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Bank mandates
        </p>
        {data.mandates.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">No mandates yet — send a Direct Debit setup link to get one signed.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {data.mandates.map((m) => (
              <li
                key={m.gcMandateId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm"
              >
                <Badge tone={mandateTone(m.state)}>{m.state.replaceAll('_', ' ')}</Badge>
                <span className="font-mono text-xs text-neutral-600">
                  {m.reference ?? m.gcMandateId}
                </span>
                {m.scheme ? (
                  <span className="text-xs uppercase text-neutral-400">{m.scheme}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recent collections */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Recent collections
        </p>
        {data.payments.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">No payments yet.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {data.payments.map((pmt) => (
              <li
                key={pmt.gcPaymentId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm"
              >
                <Badge tone={paymentTone(pmt.status)}>{pmt.status.replaceAll('_', ' ')}</Badge>
                <span className="font-medium text-neutral-800">
                  {formatMoneyMinor(pmt.amountMinor, pmt.currency)}
                </span>
                <span className="text-xs text-neutral-500">{formatDate(pmt.chargeDate)}</span>
                {pmt.description ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
                    {pmt.description}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
