// At-risk customers dashboard. Surfaces customers whose booked tutoring hours
// are at risk of expiring unused (hours expire 12 months after booking — we
// reach out before they lapse to avoid complaints). Risk is derived
// (deriveHoursRisk, CLAUDE.md §6.4); this view is not cursor-paginated because
// the population (customers holding a balance) is naturally small.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Card } from '@/components/ui/card'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

const LEVEL_BADGE: Record<string, string> = {
  high: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200',
}
const LEVEL_LABEL: Record<string, string> = {
  high: 'High risk',
  medium: 'At risk',
  low: 'Watch',
}

interface PageProps {
  searchParams: Promise<{ level?: string }>
}

export default async function AtRiskCustomersPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const minLevel =
    sp.level === 'high' || sp.level === 'low' ? sp.level : 'medium'
  const caller = await createServerCaller()
  const { items, counts } = await caller.customerRisk.list({ minLevel, limit: 300 })

  return (
    <>
      <PageHeader
        title="At-risk customers"
        subtitle="Customers sitting on booked hours they aren't using. Hours expire 12 months after booking — reach out before they lapse."
        breadcrumbs={[
          { label: 'B2C Customers', href: '/contacts' },
          { label: 'At risk', href: '/contacts/at-risk' },
        ]}
      />
      <PageBody>
        {/* Level filter + counts. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(['high', 'medium', 'low'] as const).map((lvl) => {
            const active = minLevel === lvl
            return (
              <Link
                key={lvl}
                href={`/contacts/at-risk?level=${lvl}`}
                className={
                  active
                    ? 'inline-flex items-center gap-1.5 rounded-lg border border-primary-300 bg-primary-50 px-3 py-1.5 text-sm font-medium text-primary-800'
                    : 'inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50'
                }
              >
                {lvl === 'high'
                  ? 'High only'
                  : lvl === 'medium'
                    ? 'At risk +'
                    : 'Watch +'}
              </Link>
            )
          })}
          <span className="ml-1 text-sm text-neutral-500">
            <span className="font-semibold text-red-700">{counts.high}</span> high ·{' '}
            <span className="font-semibold text-amber-700">{counts.medium}</span> at risk
            {counts.low > 0 ? (
              <>
                {' '}
                · <span className="font-semibold text-neutral-600">{counts.low}</span> watch
              </>
            ) : null}
          </span>
        </div>

        {items.length === 0 ? (
          <Card>
            <div className="px-10 py-14 text-center">
              <p className="text-sm font-medium text-neutral-800">No at-risk customers right now.</p>
              <p className="mt-1 text-xs text-neutral-500">
                Customers appear here when they hold a meaningful unused-hours balance — especially
                as the 12-month expiry approaches. Figures sync from booking.studymind.co.uk.
              </p>
            </div>
          </Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[920px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-neutral-50/95 text-left backdrop-blur">
                <tr className="border-b border-neutral-200">
                  <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Customer
                  </th>
                  <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Risk
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Booked
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Done
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Left
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Expires in
                  </th>
                  <th className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Why
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {items.map((c) => (
                  <tr key={c.id} className="group transition-colors hover:bg-neutral-50/80">
                    <td className="px-3 py-2 align-top">
                      <Link href={`/contacts/${c.id}`} className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={c.name} size={32} className="ring-2 ring-neutral-100" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-neutral-900 group-hover:text-primary-700">
                            {c.name}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2 text-xs">
                            <EmailLink email={c.email} />
                            <PhoneLink phone={c.phoneE164} />
                          </span>
                          {c.labels.length > 0 && (
                            <span className="mt-1 flex flex-wrap items-center gap-1">
                              {c.labels.map((l) => (
                                <span
                                  key={l.id}
                                  className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                  style={{
                                    backgroundColor: `${l.color ?? '#94a3b8'}1a`,
                                    color: l.color ?? '#475569',
                                  }}
                                >
                                  {l.name}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${LEVEL_BADGE[c.level]}`}
                      >
                        {LEVEL_LABEL[c.level]}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-600">
                      {c.hoursBooked != null ? `${c.hoursBooked}h` : '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums text-neutral-600">
                      {c.hoursDelivered != null ? `${c.hoursDelivered}h` : '—'}
                    </td>
                    <td className="px-3 py-2 align-top text-right font-mono text-xs tabular-nums font-semibold text-neutral-900">
                      {c.hoursRemaining}h
                    </td>
                    <td
                      className={`px-3 py-2 align-top text-right font-mono text-xs tabular-nums ${
                        c.daysToExpiry != null && c.daysToExpiry <= 30
                          ? 'font-semibold text-red-700'
                          : 'text-neutral-600'
                      }`}
                    >
                      {c.daysToExpiry == null
                        ? '—'
                        : c.daysToExpiry <= 0
                          ? 'now'
                          : `${c.daysToExpiry}d`}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-neutral-600">
                      {c.reasons[0] ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </PageBody>
    </>
  )
}
