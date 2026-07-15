// Complaints report. RSC (CLAUDE.md §26, §27). Period-scoped on complaints
// opened in the window, plus the live active backlog and the customers with the
// most open complaints. Manager+ (reports.complaints.summary is assertReports-
// gated). Mirrors the other report pages' period controls.

import Link from 'next/link'

import { LineChart } from '@/components/charts/line-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { PeriodForm } from '../_components/period-form'
import { buildPeriodPresets, parsePeriod } from '../period'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
}

function fmtHours(h: number | null): string {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${Math.round(h * 10) / 10}h`
  return `${Math.round((h / 24) * 10) / 10}d`
}

const SEVERITY_META: ReadonlyArray<{ key: 'high' | 'medium' | 'low'; label: string; cls: string }> = [
  { key: 'high', label: 'High', cls: 'bg-rose-500' },
  { key: 'medium', label: 'Medium', cls: 'bg-amber-500' },
  { key: 'low', label: 'Low', cls: 'bg-neutral-400' },
]

const STATUS_META: ReadonlyArray<{ key: 'open' | 'in_progress' | 'resolved' | 'dismissed'; label: string; cls: string }> = [
  { key: 'open', label: 'Open', cls: 'bg-primary-500' },
  { key: 'in_progress', label: 'In progress', cls: 'bg-sky-500' },
  { key: 'resolved', label: 'Resolved', cls: 'bg-emerald-500' },
  { key: 'dismissed', label: 'Dismissed', cls: 'bg-neutral-400' },
]

export default async function ComplaintsReportPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const period = parsePeriod(sp)
  const caller = await createServerCaller()
  const data = await caller.reports.complaints.summary({
    from: period.from,
    to: period.to,
  })

  const presets = buildPeriodPresets()
  const activePreset = presets.find(
    (p) => p.fromIso === period.fromIso && p.toIso === period.toIso,
  )

  const trendSeries = [
    {
      key: 'opened',
      label: 'Complaints opened',
      color: CHART_PALETTE[0]!,
      values: data.daily.labels.map((x, i) => ({ x, y: data.daily.opened[i] ?? 0 })),
    },
  ]
  const shortDay = (iso: string) => {
    const [, m, d] = iso.split('-')
    return `${Number(m)}/${Number(d)}`
  }

  const severityTotal = SEVERITY_META.reduce((s, x) => s + data.bySeverity[x.key], 0)
  const statusTotal = STATUS_META.reduce((s, x) => s + data.byStatus[x.key], 0)
  const categoryMax = Math.max(1, ...data.byCategory.map((c) => c.count))

  return (
    <>
      <PageHeader
        title="Complaints report"
        subtitle="Open backlog, complaints raised and resolved over time, severity and theme."
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Complaints', href: '/reports/complaints' },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-1.5">
              {presets.map((p) => {
                const active = activePreset?.key === p.key
                return (
                  <Link
                    key={p.key}
                    href={{ pathname: '/reports/complaints', query: { from: p.fromIso, to: p.toIso } }}
                    className={
                      active
                        ? 'inline-flex items-center rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white shadow-sm'
                        : 'inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900'
                    }
                  >
                    {p.label}
                  </Link>
                )
              })}
            </div>
            <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />
          </div>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Active backlog"
              value={data.kpis.activeBacklog}
              hint="Open + in progress now"
              tone={data.kpis.activeBacklog > 0 ? 'danger' : 'neutral'}
            />
            <Stat label="Opened" value={data.kpis.openedInPeriod} hint="In this period" tone="info" />
            <Stat
              label="Resolved"
              value={data.kpis.resolvedInPeriod}
              hint="In this period"
              tone="success"
            />
            <Stat
              label="Avg resolution"
              value={fmtHours(data.kpis.avgResolutionHours)}
              hint="Open → resolved"
            />
          </section>

          <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Complaints opened
            </h2>
            {data.daily.opened.some((n) => n > 0) ? (
              <LineChart
                title="Complaints opened per day across the selected period"
                description="Line chart of daily complaint counts."
                xLabels={data.daily.labels.map(shortDay)}
                series={trendSeries}
              />
            ) : (
              <p className="py-12 text-center text-sm text-neutral-500">
                No complaints opened in this period.
              </p>
            )}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
                By severity <span className="font-normal text-neutral-400">(opened in period)</span>
              </h2>
              {severityTotal === 0 ? (
                <p className="py-6 text-center text-sm text-neutral-500">Nothing in this period.</p>
              ) : (
                <ul className="space-y-2">
                  {SEVERITY_META.map((s) => (
                    <BreakdownBar
                      key={s.key}
                      label={s.label}
                      count={data.bySeverity[s.key]}
                      total={severityTotal}
                      barCls={s.cls}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
                By status <span className="font-normal text-neutral-400">(opened in period)</span>
              </h2>
              {statusTotal === 0 ? (
                <p className="py-6 text-center text-sm text-neutral-500">Nothing in this period.</p>
              ) : (
                <ul className="space-y-2">
                  {STATUS_META.map((s) => (
                    <BreakdownBar
                      key={s.key}
                      label={s.label}
                      count={data.byStatus[s.key]}
                      total={statusTotal}
                      barCls={s.cls}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              By theme <span className="font-normal text-neutral-400">(opened in period)</span>
            </h2>
            {data.byCategory.length === 0 ? (
              <p className="py-6 text-center text-sm text-neutral-500">No complaints in this period.</p>
            ) : (
              <ul className="space-y-2">
                {data.byCategory.map((c) => (
                  <li key={c.category} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-xs font-medium capitalize text-neutral-600">
                      {c.category}
                    </span>
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-100">
                      <div
                        className="h-full rounded-full bg-primary-500"
                        style={{ width: `${Math.round((c.count / categoryMax) * 100)}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-700">
                      {c.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
            <div className="border-b border-neutral-100 bg-rose-50/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-neutral-900">
                Customers with the most open complaints
              </h2>
              <p className="text-xs text-neutral-500">Active (open + in progress), now.</p>
            </div>
            {data.topCustomers.length === 0 ? (
              <p className="p-6 text-sm text-neutral-500">
                No active complaints — everything raised has been resolved or closed.
              </p>
            ) : (
              <Table>
                <Thead>
                  <Tr>
                    <Th>Customer</Th>
                    <Th className="text-right">Open complaints</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {data.topCustomers.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <Link
                          href={`/contacts/${c.id}#section-complaints`}
                          className="flex min-w-0 items-center gap-2.5 text-sm font-medium text-neutral-900 hover:text-primary-700"
                        >
                          <Avatar name={c.name} size={28} />
                          <span className="truncate">{c.name}</span>
                        </Link>
                      </Td>
                      <Td className="text-right font-mono text-sm tabular-nums">{c.activeCount}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </section>
        </div>
      </PageBody>
    </>
  )
}

function BreakdownBar({
  label,
  count,
  total,
  barCls,
}: {
  label: string
  count: number
  total: number
  barCls: string
}) {
  const pct = total === 0 ? 0 : Math.round((count / total) * 100)
  return (
    <li className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs font-medium text-neutral-600">{label}</span>
      <div className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-100">
        <div className={`h-full rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-700">
        {count} · {pct}%
      </span>
    </li>
  )
}

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: number | string
  hint?: string
  tone?: 'info' | 'success' | 'warn' | 'danger' | 'neutral'
}) {
  const accent: Record<typeof tone, string> = {
    info: 'text-primary-700',
    success: 'text-emerald-700',
    warn: 'text-amber-700',
    danger: 'text-rose-700',
    neutral: 'text-neutral-900',
  }
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${accent[tone]}`}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-neutral-500">{hint}</div> : null}
    </div>
  )
}
