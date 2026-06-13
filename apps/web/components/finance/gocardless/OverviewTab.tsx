'use client'

// Direct Debits master dashboard (ADR 0038). One glance answers: how much
// recurring money is on the book, what came in, what's in flight, what
// failed, and what needs a human — with one-click jumps into the working
// tabs. Read-only: every money action lives behind the human-confirmed
// flows on the other tabs (CLAUDE.md §3).

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { formatDate, PAYMENT_TONE, statusLabel } from './shared'

export function OverviewTab() {
  const overview = trpc.gocardless.overview.useQuery()
  const o = overview.data

  if (overview.isLoading) {
    return <p className="px-1 py-6 text-sm text-neutral-500">Loading dashboard…</p>
  }
  if (!o) {
    return (
      <p className="px-1 py-6 text-sm text-neutral-500">
        The dashboard could not load. Retry from the browser, or check Settings → Integrations →
        GoCardless.
      </p>
    )
  }

  const totalPlans = Object.values(o.subscriptions).reduce((s, n) => s + n, 0)
  const empty = totalPlans === 0 && o.customers.total === 0

  return (
    <div className="space-y-4">
      {empty ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">
            Nothing mirrored from GoCardless yet.
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            Run “Import full history” (top right) to pull every customer, mandate, plan and
            payment — or send your first Direct Debit setup link from the Customers tab.
          </p>
        </div>
      ) : null}

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KpiCard
          label="Monthly plan value"
          value={formatMoneyMinor(o.monthlyRunRateMinor)}
          hint={`${o.subscriptions['active'] ?? 0} active plans`}
        />
        <KpiCard
          label="Collected (30 days)"
          value={formatMoneyMinor(o.collected30d.totalMinor)}
          hint={`${o.collected30d.count} payments`}
        />
        <KpiCard
          label="In flight"
          value={formatMoneyMinor(o.inFlight.totalMinor)}
          hint={`${o.inFlight.count} pending with the bank`}
        />
        <KpiCard
          label="Failed (30 days)"
          value={formatMoneyMinor(o.failed30d.totalMinor)}
          hint={`${o.failed30d.count} payments`}
          tone={o.failed30d.count > 0 ? 'danger' : 'default'}
        />
      </div>

      {/* Secondary strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatLink
          href="/direct-debits/plans"
          label="Paused plans"
          value={String(o.subscriptions['paused'] ?? 0)}
          warn={(o.subscriptions['paused'] ?? 0) > 0}
        />
        <StatLink
          href="/direct-debits/customers"
          label="Active mandates"
          value={String(o.activeMandates)}
        />
        <StatLink
          href="/direct-debits/customers"
          label="Customers to link"
          value={String(o.customers.unlinked)}
          warn={o.customers.unlinked > 0}
        />
        <StatLink
          href="/direct-debits/customers"
          label="Sign-up links out"
          value={String(o.setupLinks.outstanding)}
        />
        <StatLink
          href="/direct-debits/issues"
          label={`Cancelled/underpaid · ${o.planIssues.shortfallCount} plan${o.planIssues.shortfallCount === 1 ? '' : 's'}`}
          value={formatMoneyMinor(o.planIssues.shortfallDueMinor)}
          warn={o.planIssues.shortfallCount > 0}
        />
        <StatLink
          href="/direct-debits/issues"
          label={`Behind schedule · ${o.planIssues.arrearsCount} plan${o.planIssues.arrearsCount === 1 ? '' : 's'}`}
          value={formatMoneyMinor(o.planIssues.arrearsDueMinor)}
          warn={o.planIssues.arrearsCount > 0}
        />
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        <QuickAction href="/direct-debits/plans" label="New plan" />
        <QuickAction href="/direct-debits/payments" label="Collect a one-off payment" />
        <QuickAction href="/direct-debits/customers" label="Send a Direct Debit setup link" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Needs attention */}
        <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-900">Needs attention</h3>
            <Link
              href="/direct-debits/payments"
              className="text-xs font-medium text-primary-700 hover:underline"
            >
              All payments →
            </Link>
          </div>
          {o.recentFailures.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">
              No failed or charged-back payments — nothing waiting on a human.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-100">
              {o.recentFailures.map((p) => (
                <li
                  key={p.gcPaymentId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
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
                      <span className="font-medium text-neutral-700">Unlinked customer</span>
                    )}
                    <Badge tone={PAYMENT_TONE[p.status] ?? 'neutral'} dot>
                      {statusLabel(p.status)}
                    </Badge>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono tabular-nums">
                      {formatMoneyMinor(p.amountMinor, p.currency)}
                    </span>
                    <span className="text-xs text-neutral-500">{formatDate(p.chargeDate)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            Retry or cancel from the Payments tab — nothing is re-collected automatically.
          </p>
        </section>

        {/* Upcoming collections */}
        <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-900">Upcoming collections</h3>
            <Link
              href="/direct-debits/plans"
              className="text-xs font-medium text-primary-700 hover:underline"
            >
              All plans →
            </Link>
          </div>
          {o.upcomingCharges.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">
              No upcoming charges on active plans yet — they appear here once GoCardless schedules
              the next collection.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-100">
              {o.upcomingCharges.map((c) => (
                <li
                  key={c.gcSubscriptionId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span className="min-w-0">
                    {c.customer?.contactId ? (
                      <Link
                        href={`/contacts/${c.customer.contactId}`}
                        className="font-medium text-primary-700 hover:underline"
                      >
                        {c.customer.contactName ?? c.customer.displayName}
                      </Link>
                    ) : c.customer ? (
                      <Link
                        href={`/direct-debits/customers/${encodeURIComponent(c.customer.gcCustomerId)}`}
                        className="font-medium text-neutral-700 hover:text-primary-700 hover:underline"
                      >
                        {c.customer.displayName}
                      </Link>
                    ) : (
                      <span className="font-medium text-neutral-700">—</span>
                    )}
                    {c.name ? (
                      <span className="ml-2 text-xs text-neutral-500">{c.name}</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono tabular-nums">
                      {formatMoneyMinor(c.amountMinor, c.currency)}
                    </span>
                    <span className="text-xs text-neutral-500">{formatDate(c.nextChargeAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="px-1 text-xs text-neutral-500">
        Collected all time through GoCardless: {formatMoneyMinor(o.collected.totalMinor)} across{' '}
        {o.collected.count} payments · {o.customers.total} customers mirrored.
      </p>
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'danger'
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-card">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-xl tabular-nums ${
          tone === 'danger' ? 'text-red-700' : 'text-neutral-900'
        }`}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-neutral-500">{hint}</div> : null}
    </div>
  )
}

function StatLink({
  href,
  label,
  value,
  warn = false,
}: {
  href: string
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-neutral-200 bg-white px-3 py-2 shadow-card transition-colors hover:border-neutral-300 hover:bg-neutral-50"
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono text-lg tabular-nums ${
          warn ? 'text-amber-700' : 'text-neutral-900'
        }`}
      >
        {value}
      </div>
    </Link>
  )
}

function QuickAction({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm transition-colors hover:border-primary-300 hover:text-primary-700"
    >
      {label}
    </Link>
  )
}
