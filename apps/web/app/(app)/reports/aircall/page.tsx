// Aircall analytics. RSC. KPIs + daily trend line + day-of-week × hour
// peak heatmap + top contacts by call volume.

import Link from 'next/link'

import { LineChart } from '@/components/charts/line-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { PeriodForm } from '../_components/period-form'
import { parsePeriod } from '../period'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
}

const KIND_TONE: Record<string, BadgeTone> = {
  parent: 'info',
  student: 'accent',
  tutor: 'success',
  la_caseworker: 'warn',
  other: 'neutral',
}

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

function shortDayLabel(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

function fmtDuration(sec: number): string {
  if (!sec) return '0:00'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const remM = m % 60
    return `${h}h ${remM}m`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtPct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`
}

function KpiTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'info'
}) {
  const bar: Record<typeof tone, string> = {
    neutral: 'bg-neutral-300',
    success: 'bg-emerald-500',
    warn: 'bg-amber-500',
    danger: 'bg-rose-500',
    info: 'bg-primary-500',
  }
  return (
    <div className="relative overflow-hidden rounded-xl border border-neutral-200 bg-white p-4 pl-5 shadow-card transition-shadow hover:shadow-card-hover">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${bar[tone]}`} />
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-neutral-900">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  )
}

// Inline peak heatmap (7 rows × 24 cols). Cell intensity = count / max.
function PeakHeatmap({ peak }: { peak: number[][] }) {
  const max = Math.max(1, ...peak.flat())
  const hourLabels = [0, 6, 9, 12, 15, 18, 21, 23] // sparse axis labels
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-[2px]">
        <thead>
          <tr>
            <th aria-hidden className="w-10" />
            {Array.from({ length: 24 }).map((_, h) => (
              <th
                key={h}
                className="text-[10px] font-medium text-neutral-400"
                aria-hidden
              >
                {hourLabels.includes(h) ? String(h).padStart(2, '0') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {peak.map((row, dow) => (
            <tr key={dow}>
              <th className="w-10 pr-2 text-right text-[10px] font-medium text-neutral-500">
                {DOW_LABELS[dow]}
              </th>
              {row.map((count, h) => {
                const intensity = count / max
                // Purple wash that scales with intensity.
                const bg =
                  count === 0
                    ? 'rgb(245 245 250)'
                    : `rgba(147 51 234 / ${Math.max(0.08, intensity).toFixed(2)})`
                return (
                  <td
                    key={h}
                    className="h-6 w-6 rounded-sm"
                    style={{ backgroundColor: bg }}
                    title={`${DOW_LABELS[dow]} ${String(h).padStart(2, '0')}:00 — ${count} call${
                      count === 1 ? '' : 's'
                    }`}
                  >
                    <span className="sr-only">
                      {DOW_LABELS[dow]} {h}:00 — {count} calls
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500">
        <span>Less</span>
        <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: 'rgb(245 245 250)' }} />
        <span
          className="h-3 w-3 rounded-sm"
          style={{ backgroundColor: 'rgba(147 51 234 / 0.20)' }}
        />
        <span
          className="h-3 w-3 rounded-sm"
          style={{ backgroundColor: 'rgba(147 51 234 / 0.50)' }}
        />
        <span
          className="h-3 w-3 rounded-sm"
          style={{ backgroundColor: 'rgba(147 51 234 / 0.85)' }}
        />
        <span>More</span>
      </div>
    </div>
  )
}

export default async function AircallReportPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const period = parsePeriod(sp)
  const caller = await createServerCaller()
  const data = await caller.reports.aircall.summary({
    from: period.from,
    to: period.to,
  })

  const trendSeries = [
    {
      key: 'calls',
      label: 'Calls',
      color: CHART_PALETTE[0]!,
      values: data.daily.labels.map((x, i) => ({
        x,
        y: data.daily.counts[i] ?? 0,
      })),
    },
  ]

  return (
    <>
      <PageHeader
        title="Aircall analytics"
        subtitle="Volumes, peak times, and call duration"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Aircall', href: '/reports/aircall' },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

          {/* KPIs */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile label="Total calls" value={String(data.kpis.total)} tone="info" />
            <KpiTile
              label="Answered"
              value={`${data.kpis.answered}`}
              hint={fmtPct(data.kpis.answeredRate)}
              tone={data.kpis.answeredRate >= 0.7 ? 'success' : 'warn'}
            />
            <KpiTile
              label="Voicemails"
              value={String(data.kpis.voicemails)}
              tone={data.kpis.voicemails > 0 ? 'warn' : 'neutral'}
            />
            <KpiTile
              label="Missed"
              value={String(data.kpis.missed)}
              tone={data.kpis.missed > 0 ? 'danger' : 'neutral'}
            />
            <KpiTile label="Inbound" value={String(data.kpis.inbound)} />
            <KpiTile label="Outbound" value={String(data.kpis.outbound)} />
            <KpiTile
              label="Avg duration"
              value={fmtDuration(data.kpis.avgDurationSec)}
              hint="Answered calls only"
            />
            <KpiTile
              label="Total talk time"
              value={fmtDuration(data.kpis.totalTalkSec)}
            />
          </div>

          {/* Daily trend */}
          <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Daily calls
            </h2>
            {data.daily.counts.some((n) => n > 0) ? (
              <LineChart
                title="Daily call volume across the selected period"
                description="Line chart of daily call counts."
                xLabels={data.daily.labels.map(shortDayLabel)}
                series={trendSeries}
              />
            ) : (
              <p className="py-12 text-center text-sm text-neutral-500">
                No calls in this period.
              </p>
            )}
          </section>

          {/* Peak time heatmap */}
          <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Peak times
            </h2>
            <p className="mb-3 text-xs text-neutral-500">
              Each cell is a day × hour bucket. Darker cells mean more calls landed there.
            </p>
            <PeakHeatmap peak={data.peak} />
          </section>

          {/* Top contacts */}
          <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
            <div className="border-b border-neutral-100 bg-neutral-50/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-neutral-900">
                Top contacts by call volume
              </h2>
            </div>
            {data.topContacts.length === 0 ? (
              <p className="p-6 text-sm text-neutral-500">
                No calls landed against a known contact in this period.
              </p>
            ) : (
              <Table>
                <Thead>
                  <Tr>
                    <Th>Contact</Th>
                    <Th>Type</Th>
                    <Th className="text-right">Calls</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {data.topContacts.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <Link
                          href={`/contacts/${c.id}`}
                          className="flex min-w-0 items-center gap-2.5 text-sm font-medium text-neutral-900 hover:text-primary-700"
                        >
                          <Avatar name={c.name} size={28} />
                          <span className="truncate">{c.name}</span>
                          {c.phoneE164 ? (
                            <span className="ml-2 truncate font-mono text-xs text-neutral-500">
                              {c.phoneE164}
                            </span>
                          ) : null}
                        </Link>
                      </Td>
                      <Td>
                        {c.kind ? (
                          <Badge tone={KIND_TONE[c.kind] ?? 'neutral'} dot>
                            {c.kind.replace('_', ' ')}
                          </Badge>
                        ) : (
                          <span className="text-xs text-neutral-400">—</span>
                        )}
                      </Td>
                      <Td className="text-right font-mono text-sm tabular-nums">{c.count}</Td>
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
