// At-risk customers dashboard (client island). Renders the scored rows from
// customerRisk.list and adds per-row triage: flag / dismiss / clear. View +
// level lenses live in the URL so the view is shareable. CLAUDE.md §26
// (client leaf), §27 (mutations via tRPC).

'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { riskLabel, riskTone } from '@/lib/ui/status-tone'
import { Card } from '@/components/ui/card'
import { EmailLink, PhoneLink } from '@/components/shared/channel-links'
import { trpc } from '@/lib/trpc/client'

type Level = 'none' | 'low' | 'medium' | 'high'
type View = 'open' | 'flagged' | 'dismissed' | 'all'

interface LabelChip {
  id: string
  name: string
  color: string | null
}

export interface RiskRow {
  id: string
  name: string
  email: string | null
  phoneE164: string | null
  hoursBooked: number | null
  hoursDelivered: number | null
  hoursRemaining: number
  daysToExpiry: number | null
  level: Level
  score: number
  reasons: string[]
  labels: LabelChip[]
  reviewStatus: 'flagged' | 'dismissed' | null
  reviewNote: string | null
  complaintCount: number
}

interface Counts {
  high: number
  medium: number
  low: number
  flagged: number
  total: number
}

const CAN_REVIEW = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

export function AtRiskDashboard({
  items,
  counts,
  minLevel,
  view,
  role,
}: {
  items: RiskRow[]
  counts: Counts
  minLevel: 'low' | 'medium' | 'high'
  view: View
  role: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const utils = trpc.useUtils()
  const canReview = CAN_REVIEW.has(role)

  const setReview = trpc.customerRisk.setReview.useMutation()
  const clearReview = trpc.customerRisk.clearReview.useMutation()

  function refresh() {
    void utils.customerRisk.list.invalidate()
    router.refresh()
  }

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set(key, value)
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  async function flag(row: RiskRow) {
    await setReview.mutateAsync({ contactId: row.id, status: 'flagged', levelAtReview: row.level })
    toast.success(`Flagged ${row.name}`)
    refresh()
  }
  async function dismiss(row: RiskRow) {
    await setReview.mutateAsync({ contactId: row.id, status: 'dismissed', levelAtReview: row.level })
    toast.success(`Dismissed ${row.name}`)
    refresh()
  }
  async function clear(row: RiskRow) {
    await clearReview.mutateAsync({ contactId: row.id })
    toast.success(`Cleared review for ${row.name}`)
    refresh()
  }

  const VIEWS: Array<{ key: View; label: string }> = [
    { key: 'open', label: 'Open' },
    { key: 'flagged', label: `Flagged${counts.flagged ? ` (${counts.flagged})` : ''}` },
    { key: 'dismissed', label: 'Dismissed' },
    { key: 'all', label: 'All' },
  ]

  return (
    <div className="space-y-4">
      {/* View + level lenses + counts. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setParam('view', v.key)}
              className={
                view === v.key
                  ? 'rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white'
                  : 'rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100'
              }
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5">
          {(['high', 'medium', 'low'] as const).map((lvl) => (
            <button
              key={lvl}
              type="button"
              onClick={() => setParam('level', lvl)}
              className={
                minLevel === lvl
                  ? 'rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white'
                  : 'rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100'
              }
            >
              {lvl === 'high' ? 'High only' : lvl === 'medium' ? 'At risk +' : 'Watch +'}
            </button>
          ))}
        </div>

        <span className="ml-1 text-sm text-neutral-500">
          <span className="font-semibold text-red-700">{counts.high}</span> high ·{' '}
          <span className="font-semibold text-amber-700">{counts.medium}</span> at risk
        </span>
      </div>

      {items.length === 0 ? (
        <Card>
          <div className="px-10 py-14 text-center">
            <p className="text-sm font-medium text-neutral-800">Nothing here right now.</p>
            <p className="mt-1 text-xs text-neutral-500">
              Customers appear when they hold a meaningful unused-hours balance — especially as the
              12-month expiry approaches. Figures sync from booking.studymind.co.uk.
            </p>
          </div>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[1000px] border-collapse text-sm">
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
                {canReview && <th className="px-3 py-2.5 text-right" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {items.map((c) => (
                <tr key={c.id} className="group align-top transition-colors hover:bg-neutral-50/80">
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={c.name} size={32} className="ring-2 ring-neutral-100" />
                      <span className="min-w-0">
                        <Link
                          href={`/contacts/${c.id}`}
                          className="block truncate font-medium text-neutral-900 hover:text-primary-700"
                        >
                          {c.name}
                        </Link>
                        <span className="mt-0.5 flex items-center gap-2 text-xs">
                          <EmailLink email={c.email} />
                          <PhoneLink phone={c.phoneE164} />
                        </span>
                        {(c.labels.length > 0 || c.complaintCount > 0) && (
                          <span className="mt-1 flex flex-wrap items-center gap-1">
                            {c.complaintCount > 0 && (
                              <Link
                                href={`/contacts/${c.id}#section-complaints`}
                                className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100"
                                title="Active complaints — open the customer's Complaints section"
                              >
                                {c.complaintCount} complaint{c.complaintCount === 1 ? '' : 's'}
                              </Link>
                            )}
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
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex flex-col items-start gap-1">
                      <Badge tone={riskTone(c.level)} className="uppercase tracking-wide">
                        {riskLabel(c.level)}
                      </Badge>
                      {c.reviewStatus === 'flagged' && (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                          Flagged
                        </span>
                      )}
                      {c.reviewStatus === 'dismissed' && (
                        <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-500">
                          Dismissed
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-neutral-600">
                    {c.hoursBooked != null ? `${c.hoursBooked}h` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-neutral-600">
                    {c.hoursDelivered != null ? `${c.hoursDelivered}h` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs font-semibold tabular-nums text-neutral-900">
                    {c.hoursRemaining}h
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs tabular-nums ${
                      c.daysToExpiry != null && c.daysToExpiry <= 30
                        ? 'font-semibold text-red-700'
                        : 'text-neutral-600'
                    }`}
                  >
                    {c.daysToExpiry == null ? '—' : c.daysToExpiry <= 0 ? 'now' : `${c.daysToExpiry}d`}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-600">{c.reasons[0] ?? '—'}</td>
                  {canReview && (
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        {c.reviewStatus === 'flagged' ? (
                          <button
                            type="button"
                            onClick={() => clear(c)}
                            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
                          >
                            Unflag
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => flag(c)}
                            className="rounded px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50"
                          >
                            Flag
                          </button>
                        )}
                        {c.reviewStatus === 'dismissed' ? (
                          <button
                            type="button"
                            onClick={() => clear(c)}
                            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
                          >
                            Restore
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => dismiss(c)}
                            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

    </div>
  )
}
