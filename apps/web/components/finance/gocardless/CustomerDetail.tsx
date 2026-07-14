'use client'

// GoCardless customer record (ADR 0038) — mirrors the structure of the
// GoCardless dashboard's customer page: identity + lifetime totals up top,
// then bank mandates, plans (all statuses), recent payments, and outstanding
// sign-up links. Money actions deep-link into the working tabs pre-filtered
// to this customer; mandate cancellation lives here (human-confirmed,
// audited — CLAUDE.md §3).

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import {
  ContactSearch,
  formatDate,
  MANDATE_TONE,
  PAYMENT_TONE,
  statusLabel,
  SUBSCRIPTION_TONE,
} from './shared'

const SETUP_LINK_TONE: Record<string, Parameters<typeof Badge>[0]['tone']> = {
  active: 'info',
  completed: 'success',
  revoked: 'neutral',
  expired: 'warn',
}

export function CustomerDetail({ gcCustomerId }: { gcCustomerId: string }) {
  const utils = trpc.useUtils()
  const detail = trpc.gocardless.customers.detail.useQuery({ gcCustomerId })
  const [linking, setLinking] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<string | null>(null)
  const [reinstateTarget, setReinstateTarget] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [editing, setEditing] = useState(false)
  const [editFields, setEditFields] = useState({
    givenName: '',
    familyName: '',
    email: '',
    phone: '',
  })

  const refresh = () => {
    void utils.gocardless.customers.detail.invalidate({ gcCustomerId })
    void utils.gocardless.customers.list.invalidate()
    void utils.gocardless.overview.invalidate()
  }

  const link = trpc.gocardless.customers.link.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.contactId
          ? `Linked${res.linkedMandates ? ` — ${res.linkedMandates} mandate(s) now reconcile` : ''}.`
          : 'Link removed.',
      )
      setLinking(false)
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  const cancelMandate = trpc.gocardless.mandates.cancel.useMutation({
    onSuccess: () => {
      toast.success('Mandate cancelled.')
      setCancelTarget(null)
      setReason('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const reinstateMandate = trpc.gocardless.mandates.reinstate.useMutation({
    onSuccess: () => {
      toast.success('Mandate reinstated.')
      setReinstateTarget(null)
      setReason('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const updateCustomer = trpc.gocardless.customers.update.useMutation({
    onSuccess: () => {
      toast.success('Customer details updated at GoCardless.')
      setEditing(false)
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  if (detail.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading customer…</p>
  }
  const data = detail.data
  if (!data) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
        <p className="text-sm font-medium text-neutral-700">Customer not found.</p>
        <Link
          href="/direct-debits/customers"
          className="mt-2 inline-block text-sm font-medium text-primary-700 hover:underline"
        >
          ← Back to customers
        </Link>
      </div>
    )
  }

  const { customer, totals } = data
  const filterQs = `?customer=${encodeURIComponent(customer.gcCustomerId)}`

  return (
    <div className="space-y-4">
      <Link
        href="/direct-debits/customers"
        className="inline-block text-sm text-neutral-500 hover:text-neutral-900"
      >
        ← Customers &amp; mandates
      </Link>

      {/* Identity header */}
      <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">
              {customer.name ?? customer.email ?? customer.gcCustomerId}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
              {customer.email ? <span>{customer.email}</span> : null}
              <code className="font-mono text-xs text-neutral-400">{customer.gcCustomerId}</code>
              <span>Customer since {formatDate(customer.gcCreatedAt ?? customer.createdAt)}</span>
              <Button size="xs" variant="ghost" onClick={() => setEditing((v) => !v)}>
                {editing ? 'Close' : 'Edit details'}
              </Button>
            </div>
            {editing ? (
              <div className="mt-3 grid max-w-2xl gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 sm:grid-cols-2">
                <Input
                  aria-label="First name"
                  placeholder="First name"
                  value={editFields.givenName}
                  onChange={(e) => setEditFields((f) => ({ ...f, givenName: e.target.value }))}
                />
                <Input
                  aria-label="Last name"
                  placeholder="Last name"
                  value={editFields.familyName}
                  onChange={(e) => setEditFields((f) => ({ ...f, familyName: e.target.value }))}
                />
                <Input
                  aria-label="Email"
                  placeholder={customer.email ?? 'Email'}
                  value={editFields.email}
                  onChange={(e) => setEditFields((f) => ({ ...f, email: e.target.value }))}
                />
                <Input
                  aria-label="Phone"
                  placeholder="Phone"
                  value={editFields.phone}
                  onChange={(e) => setEditFields((f) => ({ ...f, phone: e.target.value }))}
                />
                <p className="text-xs text-neutral-500 sm:col-span-2">
                  Only filled fields are changed — updates the customer record AT GoCardless and
                  mirrors back here. The CRM contact link is untouched.
                </p>
                <div className="flex gap-2 sm:col-span-2">
                  <Button
                    size="xs"
                    disabled={
                      updateCustomer.isPending ||
                      Object.values(editFields).every((v) => v.trim() === '')
                    }
                    onClick={() =>
                      updateCustomer.mutate({
                        gcCustomerId: customer.gcCustomerId,
                        ...(editFields.givenName.trim()
                          ? { givenName: editFields.givenName.trim() }
                          : {}),
                        ...(editFields.familyName.trim()
                          ? { familyName: editFields.familyName.trim() }
                          : {}),
                        ...(editFields.email.trim() ? { email: editFields.email.trim() } : {}),
                        ...(editFields.phone.trim() ? { phone: editFields.phone.trim() } : {}),
                      })
                    }
                  >
                    {updateCustomer.isPending ? 'Saving…' : 'Save to GoCardless'}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="mt-2">
              {customer.contactId ? (
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="success" dot>
                    Linked
                  </Badge>
                  <Link
                    href={`/contacts/${customer.contactId}`}
                    className="font-medium text-primary-700 hover:underline"
                  >
                    {customer.contactName ?? 'View CRM contact'}
                  </Link>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={link.isPending}
                    onClick={() =>
                      link.mutate({ gcCustomerId: customer.gcCustomerId, contactId: null })
                    }
                  >
                    Unlink
                  </Button>
                </span>
              ) : linking ? (
                <div className="max-w-md">
                  <ContactSearch
                    busy={link.isPending}
                    onPick={(contactId) =>
                      link.mutate({ gcCustomerId: customer.gcCustomerId, contactId })
                    }
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    className="mt-1"
                    onClick={() => setLinking(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <span className="flex items-center gap-2">
                  <Badge tone="warn" dot>
                    Not linked to the CRM
                  </Badge>
                  <Button size="xs" variant="secondary" onClick={() => setLinking(true)}>
                    Link to contact
                  </Button>
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2 text-right">
            <HeaderStat label="Collected (lifetime)" value={formatMoneyMinor(totals.collectedMinor)} />
            <HeaderStat label="Payments" value={String(totals.paymentCount)} />
            <HeaderStat label="Active plans" value={String(totals.activePlans)} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-neutral-100 pt-3">
          <Link
            href={`/direct-debits/plans${filterQs}`}
            className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm transition-colors hover:border-primary-300 hover:text-primary-700"
          >
            New plan for this customer
          </Link>
          <Link
            href={`/direct-debits/payments${filterQs}`}
            className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm transition-colors hover:border-primary-300 hover:text-primary-700"
          >
            Collect a one-off payment
          </Link>
        </div>
      </div>

      {/* Bank mandates */}
      <Section title="Bank mandates" count={data.mandates.length}>
        {data.mandates.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">
            No mandates — send a Direct Debit setup link from the Customers tab.
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Mandate</Th>
                <Th>Reference</Th>
                <Th>Scheme</Th>
                <Th>Status</Th>
                <Th>Next possible charge</Th>
                <Th>Created</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {data.mandates.map((m) => (
                <Tr key={m.gcMandateId}>
                  <Td>
                    <code className="font-mono text-xs">{m.gcMandateId}</code>
                  </Td>
                  <Td className="text-neutral-600">{m.reference ?? '—'}</Td>
                  <Td className="text-neutral-600">{m.scheme ?? '—'}</Td>
                  <Td>
                    <Badge tone={MANDATE_TONE[m.state] ?? 'neutral'} dot>
                      {statusLabel(m.state)}
                    </Badge>
                  </Td>
                  <Td className="text-neutral-600">{formatDate(m.nextPossibleChargeDate)}</Td>
                  <Td className="text-neutral-600">{formatDate(m.gcCreatedAt)}</Td>
                  <Td>
                    {['active', 'submitted', 'pending_submission'].includes(m.state) ? (
                      cancelTarget === m.gcMandateId ? (
                        <span className="flex items-center justify-end gap-2">
                          <Input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Reason (audited)"
                            className="h-7 w-48 text-xs"
                          />
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={cancelMandate.isPending || reason.trim().length < 2}
                            onClick={() =>
                              cancelMandate.mutate({
                                gcMandateId: m.gcMandateId,
                                reason: reason.trim(),
                              })
                            }
                          >
                            Confirm cancel
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setCancelTarget(null)
                              setReason('')
                            }}
                          >
                            Back
                          </Button>
                        </span>
                      ) : (
                        <div className="flex justify-end">
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-red-700"
                            onClick={() => setCancelTarget(m.gcMandateId)}
                          >
                            Cancel mandate
                          </Button>
                        </div>
                      )
                    ) : ['cancelled', 'expired'].includes(m.state) ? (
                      reinstateTarget === m.gcMandateId ? (
                        <span className="flex items-center justify-end gap-2">
                          <Input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Reason (audited)"
                            className="h-7 w-48 text-xs"
                          />
                          <Button
                            size="xs"
                            disabled={reinstateMandate.isPending || reason.trim().length < 2}
                            onClick={() =>
                              reinstateMandate.mutate({
                                gcMandateId: m.gcMandateId,
                                reason: reason.trim(),
                              })
                            }
                          >
                            Confirm reinstate
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setReinstateTarget(null)
                              setReason('')
                            }}
                          >
                            Back
                          </Button>
                        </span>
                      ) : (
                        <div className="flex justify-end">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setReinstateTarget(m.gcMandateId)}
                          >
                            Reinstate
                          </Button>
                        </div>
                      )
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      {/* Plans */}
      <Section
        title="Plans"
        count={data.subscriptions.length}
        action={{ href: `/direct-debits/plans${filterQs}`, label: 'Manage plans →' }}
      >
        {data.subscriptions.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">No plans for this customer yet.</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Plan</Th>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th>Next charge</Th>
                <Th>Started</Th>
                <Th>Ended</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.subscriptions.map((s) => (
                <Tr key={s.gcSubscriptionId}>
                  <Td>
                    <span className="text-neutral-900">{s.name ?? '—'}</span>{' '}
                    <code className="font-mono text-[11px] text-neutral-400">
                      {s.gcSubscriptionId}
                    </code>
                  </Td>
                  <Td className="text-right font-mono tabular-nums">
                    {formatMoneyMinor(s.amountMinor, s.currency)}{' '}
                    <span className="text-xs text-neutral-500">/ {s.intervalUnit.replace('ly', '')}</span>
                  </Td>
                  <Td>
                    <Badge tone={SUBSCRIPTION_TONE[s.status] ?? 'neutral'} dot>
                      {statusLabel(s.status)}
                    </Badge>
                  </Td>
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
                  <Td className="text-neutral-600">{formatDate(s.endDate)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      {/* Recent payments */}
      <Section
        title="Recent payments"
        count={totals.paymentCount}
        action={{ href: `/direct-debits/payments${filterQs}`, label: 'All payments →' }}
      >
        {data.payments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-neutral-500">No payments yet.</p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th>Charge date</Th>
                <Th>Description</Th>
                <Th>Plan</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.payments.map((p) => (
                <Tr key={p.gcPaymentId}>
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
                  <Td>
                    {p.gcSubscriptionId ? (
                      <code className="font-mono text-[11px] text-neutral-500">
                        {p.gcSubscriptionId}
                      </code>
                    ) : (
                      <span className="text-xs text-neutral-400">one-off</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      {/* Sign-up links */}
      {data.setupLinks.length > 0 ? (
        <Section title="Direct Debit sign-up links" count={data.setupLinks.length}>
          <ul className="divide-y divide-neutral-100 px-4">
            {data.setupLinks.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Badge tone={SETUP_LINK_TONE[l.status] ?? 'neutral'} dot>
                  {l.status}
                </Badge>
                <span className="text-xs text-neutral-500">
                  {l.emailedAt
                    ? `emailed ${formatDate(l.emailedAt)}${l.emailTo ? ` (${l.emailTo})` : ''}`
                    : 'not emailed'}
                  {l.reminderSentAt ? ` · reminded ${formatDate(l.reminderSentAt)}` : ''}
                  {l.openCount > 0 ? ` · opened ×${l.openCount}` : ''}
                  {l.status === 'active' ? ` · expires ${formatDate(l.expiresAt)}` : ''}
                  {l.status === 'completed' && l.completedAt
                    ? ` · completed ${formatDate(l.completedAt)}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  )
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-right">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-base tabular-nums text-neutral-900">{value}</div>
    </div>
  )
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: { href: string; label: string }
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-neutral-900">
          {title}
          {count !== undefined ? (
            <span className="ml-1.5 font-normal text-neutral-400">({count})</span>
          ) : null}
        </h3>
        {action ? (
          <Link href={action.href} className="text-xs font-medium text-primary-700 hover:underline">
            {action.label}
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  )
}
