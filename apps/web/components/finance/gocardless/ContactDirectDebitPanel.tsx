// The customer page's Direct Debit panel (ADR 0038). Surfaces the GoCardless
// picture for this contact — mandates, active plans, recent collections,
// outstanding sign-up links — with a one-click "Send a setup link" for
// finance roles and a deep link into the Direct Debits workspace. Read-only
// for everyone else; money actions stay in /direct-debits.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
  /** ceo / senior_manager / manager — shows the send-setup-link action. */
  canManage: boolean
}

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

export function ContactDirectDebitPanel({ contactId, canManage }: Props) {
  const summary = trpc.gocardless.contactSummary.useQuery({ contactId })
  const sendLink = trpc.gocardless.setupLinks.send.useMutation({
    onSuccess: async (r) => {
      toast.success(
        r.emailedTo ? `Setup link emailed to ${r.emailedTo}` : 'Setup link created — copy it below.',
      )
      await summary.refetch()
    },
    onError: (e) => toast.error(e.message ?? 'Could not create the setup link'),
  })
  const [confirmingSend, setConfirmingSend] = useState(false)

  if (summary.isLoading) {
    return <p className="text-sm text-neutral-500">Loading Direct Debit details…</p>
  }
  const data = summary.data
  if (!data) {
    return <p className="text-sm text-neutral-500">Direct Debit details unavailable.</p>
  }

  const activeMandates = data.mandates.filter((m) => m.state === 'active')
  const outstandingLinks = data.setupLinks.filter((l) => l.status === 'active')
  const firstCustomer = data.customers[0] ?? null
  const empty =
    data.customers.length === 0 && data.setupLinks.length === 0 && data.mandates.length === 0

  return (
    <div className="space-y-4">
      {/* Header row: state at a glance + actions */}
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
          ) : outstandingLinks.length > 0 ? (
            <Badge tone="info" dot>
              Sign-up link outstanding
            </Badge>
          ) : (
            <Badge tone="neutral">No Direct Debit</Badge>
          )}
          {firstCustomer ? (
            <span className="text-xs text-neutral-500">
              GoCardless: {firstCustomer.name ?? firstCustomer.email ?? firstCustomer.gcCustomerId}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && !confirmingSend ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setConfirmingSend(true)}
              disabled={sendLink.isPending}
            >
              Send a Direct Debit setup link
            </Button>
          ) : null}
          {firstCustomer ? (
            <Link
              href={`/direct-debits/customers/${firstCustomer.gcCustomerId}`}
              className="text-xs font-medium text-primary-700 hover:underline"
            >
              Open in Direct Debits →
            </Link>
          ) : canManage ? (
            <Link
              href="/direct-debits/customers"
              className="text-xs font-medium text-primary-700 hover:underline"
            >
              Direct Debits workspace →
            </Link>
          ) : null}
        </div>
      </div>

      {confirmingSend ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary-200 bg-primary-50/50 px-3 py-2 text-sm">
          <span className="text-neutral-700">
            Email this contact a secure Direct Debit sign-up link (14-day expiry, one polite
            reminder after 3 days)?
          </span>
          <Button
            type="button"
            size="sm"
            disabled={sendLink.isPending}
            onClick={() => {
              setConfirmingSend(false)
              sendLink.mutate({ contactId, sendEmail: true })
            }}
          >
            {sendLink.isPending ? 'Sending…' : 'Send it'}
          </Button>
          <button
            type="button"
            className="text-xs text-neutral-600 hover:underline"
            onClick={() => setConfirmingSend(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {empty ? (
        <p className="text-sm text-neutral-600">
          No GoCardless customer, mandate or sign-up link for this contact yet
          {canManage
            ? ' — send a setup link above to start a Direct Debit.'
            : ' — a Manager can send a setup link to start a Direct Debit.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Mandates */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Mandates
            </p>
            {data.mandates.length === 0 ? (
              <p className="mt-1 text-sm text-neutral-500">None yet.</p>
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
                    {m.nextPossibleChargeDate ? (
                      <span className="ml-auto text-xs text-neutral-500">
                        chargeable from {formatDate(m.nextPossibleChargeDate)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
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

          {/* Recent payments */}
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

          {/* Sign-up links */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Sign-up links
            </p>
            {data.setupLinks.length === 0 ? (
              <p className="mt-1 text-sm text-neutral-500">None sent.</p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {data.setupLinks.map((l) => (
                  <li
                    key={l.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm"
                  >
                    <Badge
                      tone={
                        l.status === 'completed'
                          ? 'success'
                          : l.status === 'active'
                            ? 'info'
                            : 'neutral'
                      }
                    >
                      {l.status}
                    </Badge>
                    {l.emailTo ? (
                      <span className="text-xs text-neutral-600">{l.emailTo}</span>
                    ) : null}
                    {l.emailedAt ? (
                      <span className="text-xs text-neutral-500">
                        emailed {formatDate(l.emailedAt)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-neutral-400">
                      {l.status === 'completed' && l.completedAt
                        ? `completed ${formatDate(l.completedAt)}`
                        : l.openCount > 0
                          ? `opened ${l.openCount}×`
                          : l.expiresAt
                            ? `expires ${formatDate(l.expiresAt)}`
                            : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
