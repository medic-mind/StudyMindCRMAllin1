// Aircall analytics. RSC. KPIs (with period-over-period delta) + direction
// filter + daily trend (total / inbound / outbound) + day-of-week × hour
// peak heatmap + hourly throughput + duration distribution + missed +
// voicemail trays + top contacts by call volume.

import Link from 'next/link'

import { LineChart } from '@/components/charts/line-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { PeriodForm } from '../_components/period-form'
import { buildPeriodPresets, parsePeriod } from '../period'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
  direction?: string
  provider?: string
}

type Direction = 'all' | 'inbound' | 'outbound'
type Provider = 'all' | 'aircall' | 'google_voice' | 'manual'

const KIND_TONE: Record<string, BadgeTone> = {
  parent: 'info',
  student: 'accent',
  tutor: 'success',
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
  const s = Math.abs(sec) % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const remM = m % 60
    return `${sec < 0 ? '-' : ''}${h}h ${remM}m`
  }
  return `${sec < 0 ? '-' : ''}${m}:${String(s).padStart(2, '0')}`
}

function fmtPct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`
}

function fmtSignedInt(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}

function fmtSignedPct(n: number): string {
  const v = Math.round(n * 1000) / 10
  return v > 0 ? `+${v}%` : `${v}%`
}

function KpiTile({
  label,
  value,
  hint,
  delta,
  deltaDir = 'up_is_good',
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  delta?: string
  deltaDir?: 'up_is_good' | 'up_is_bad' | 'neutral'
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'info'
}) {
  const bar: Record<typeof tone, string> = {
    neutral: 'bg-neutral-300',
    success: 'bg-emerald-500',
    warn: 'bg-amber-500',
    danger: 'bg-rose-500',
    info: 'bg-primary-500',
  }
  const deltaColor = (() => {
    if (!delta) return 'text-neutral-500'
    const positive = delta.startsWith('+')
    const zero = delta === '+0' || delta === '0' || delta === '+0%' || delta === '0%' || delta === '+0:00'
    if (zero) return 'text-neutral-500'
    if (deltaDir === 'neutral') return 'text-neutral-500'
    const good =
      (deltaDir === 'up_is_good' && positive) || (deltaDir === 'up_is_bad' && !positive)
    return good ? 'text-emerald-700' : 'text-rose-700'
  })()
  return (
    <div className="relative overflow-hidden rounded-xl border border-neutral-200 bg-white p-4 pl-5 shadow-card transition-shadow hover:shadow-card-hover">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${bar[tone]}`} />
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-neutral-900">
        {value}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {delta ? (
          <span className={`text-xs font-medium tabular-nums ${deltaColor}`}>{delta} vs prev</span>
        ) : null}
        {hint ? <span className="text-xs text-neutral-500">{hint}</span> : null}
      </div>
    </div>
  )
}

// Inline peak heatmap (7 rows × 24 cols).
function PeakHeatmap({ peak }: { peak: number[][] }) {
  const max = Math.max(1, ...peak.flat())
  const hourLabels = [0, 6, 9, 12, 15, 18, 21, 23]
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-[2px]">
        <thead>
          <tr>
            <th aria-hidden className="w-10" />
            {Array.from({ length: 24 }).map((_, h) => (
              <th key={h} className="text-[10px] font-medium text-neutral-400" aria-hidden>
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
                const bg =
                  count === 0
                    ? 'rgb(245 245 250)'
                    : `rgba(147 51 234 / ${Math.max(0.08, intensity).toFixed(2)})`
                return (
                  <td
                    key={h}
                    className="h-6 w-6 rounded-sm"
                    style={{ backgroundColor: bg }}
                    title={`${DOW_LABELS[dow]} ${String(h).padStart(2, '0')}:00 — ${count} call${count === 1 ? '' : 's'}`}
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
    </div>
  )
}

function WeeklyHoursBars({
  weekStarts,
  hours,
  calls,
}: {
  weekStarts: string[]
  hours: number[]
  calls: number[]
}) {
  if (weekStarts.length === 0 || hours.every((h) => h === 0)) {
    return (
      <p className="py-12 text-center text-sm text-neutral-500">
        No call hours logged in this period.
      </p>
    )
  }
  const max = Math.max(1, ...hours)
  function shortWk(iso: string): string {
    const [, m, d] = iso.split('-')
    return `${Number(m)}/${Number(d)}`
  }
  return (
    <div
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${weekStarts.length}, minmax(0, 1fr))` }}
    >
      {weekStarts.map((wk, i) => {
        const h = hours[i] ?? 0
        const c = calls[i] ?? 0
        const pct = Math.round((h / max) * 100)
        return (
          <div key={wk} className="flex flex-col items-center gap-1.5">
            <span className="font-mono text-[10px] tabular-nums text-neutral-600">
              {h > 0 ? `${h}h` : ''}
            </span>
            <div className="flex h-32 w-full items-end">
              <div
                className="w-full rounded-t bg-primary-500/85 transition-colors hover:bg-primary-600"
                style={{ height: `${Math.max(2, pct)}%` }}
                title={`Week of ${shortWk(wk)} — ${h}h on ${c} calls`}
              />
            </div>
            <span className="text-[10px] text-neutral-500">{shortWk(wk)}</span>
          </div>
        )
      })}
    </div>
  )
}

function HourlyBars({ hourly }: { hourly: number[] }) {
  const max = Math.max(1, ...hourly)
  return (
    <div className="grid grid-cols-24 gap-1" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
      {hourly.map((count, h) => {
        const pct = Math.round((count / max) * 100)
        return (
          <div key={h} className="flex flex-col items-center gap-1">
            <div className="flex h-24 w-full items-end">
              <div
                className="w-full rounded-t bg-primary-500/80"
                style={{ height: `${Math.max(2, pct)}%` }}
                title={`${String(h).padStart(2, '0')}:00 — ${count} calls`}
              />
            </div>
            <span className="text-[9px] text-neutral-400">
              {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function DurationBars({
  buckets,
}: {
  buckets: ReadonlyArray<{ key: string; label: string; count: number }>
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  return (
    <ul className="space-y-2">
      {buckets.map((b) => {
        const pct = Math.round((b.count / max) * 100)
        return (
          <li key={b.key} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs font-medium text-neutral-600">{b.label}</span>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-neutral-100">
              <div
                className="h-full rounded-full bg-primary-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-700">
              {b.count}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function TrayList({
  rows,
  emptyText,
}: {
  rows: ReadonlyArray<{
    callId: string
    contactId: string | null
    name: string
    direction: 'inbound' | 'outbound' | null
    occurredAt: Date | string
  }>
  emptyText: string
}) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-neutral-500">{emptyText}</p>
  return (
    <ul className="divide-y divide-neutral-100">
      {rows.map((r) => (
        <li key={r.callId} className="flex items-center gap-3 py-2.5">
          <Avatar name={r.name} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-neutral-900">
              {r.contactId ? (
                <Link href={`/contacts/${r.contactId}`} className="hover:text-primary-700 hover:underline">
                  {r.name}
                </Link>
              ) : (
                r.name
              )}
            </div>
            <div className="text-xs text-neutral-500">
              {r.direction ? `${r.direction[0]?.toUpperCase()}${r.direction.slice(1)}` : '—'} ·{' '}
              <time dateTime={new Date(r.occurredAt).toISOString()}>
                {new Intl.DateTimeFormat('en-GB', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(r.occurredAt))}
              </time>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default async function AircallReportPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const period = parsePeriod(sp)
  const direction: Direction =
    sp.direction === 'inbound' || sp.direction === 'outbound' ? sp.direction : 'all'
  const provider: Provider =
    sp.provider === 'aircall' ||
    sp.provider === 'google_voice' ||
    sp.provider === 'manual'
      ? sp.provider
      : 'all'
  const caller = await createServerCaller()
  const data = await caller.reports.aircall.summary({
    from: period.from,
    to: period.to,
    direction,
    provider,
  })

  const presets = buildPeriodPresets()
  const activePreset = presets.find(
    (p) => p.fromIso === period.fromIso && p.toIso === period.toIso,
  )

  const directionTabs: Array<{ key: Direction; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'inbound', label: 'Inbound' },
    { key: 'outbound', label: 'Outbound' },
  ]
  const providerTabs: Array<{ key: Provider; label: string }> = [
    { key: 'all', label: 'All providers' },
    { key: 'aircall', label: 'Aircall' },
    { key: 'google_voice', label: 'Google Voice' },
    { key: 'manual', label: 'Manual log' },
  ]

  function hrefWith(overrides: {
    from?: string
    to?: string
    direction?: Direction
    provider?: Provider
  }): { pathname: string; query: Record<string, string> } {
    const q: Record<string, string> = {
      from: overrides.from ?? period.fromIso,
      to: overrides.to ?? period.toIso,
    }
    const nextDirection = overrides.direction ?? direction
    if (nextDirection !== 'all') q.direction = nextDirection
    const nextProvider = overrides.provider ?? provider
    if (nextProvider !== 'all') q.provider = nextProvider
    return { pathname: '/reports/aircall', query: q }
  }

  function directionHref(d: Direction) {
    return hrefWith({ direction: d })
  }
  function providerHref(p: Provider) {
    return hrefWith({ provider: p })
  }
  function presetHref(fromIso: string, toIso: string) {
    return hrefWith({ from: fromIso, to: toIso })
  }

  const trendSeries = [
    {
      key: 'total',
      label: 'All calls',
      color: CHART_PALETTE[0]!,
      values: data.daily.labels.map((x, i) => ({ x, y: data.daily.counts[i] ?? 0 })),
    },
    {
      key: 'inbound',
      label: 'Inbound',
      color: CHART_PALETTE[2]!,
      values: data.daily.labels.map((x, i) => ({ x, y: data.daily.inbound[i] ?? 0 })),
    },
    {
      key: 'outbound',
      label: 'Outbound',
      color: CHART_PALETTE[4]!,
      values: data.daily.labels.map((x, i) => ({ x, y: data.daily.outbound[i] ?? 0 })),
    },
  ]

  return (
    <>
      <PageHeader
        title="Aircall analytics"
        subtitle="Volumes, peak times, duration distribution, and call quality"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Aircall', href: '/reports/aircall' },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          {/* Quick-pick period presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            {presets.map((p) => {
              const active = activePreset?.key === p.key
              return (
                <Link
                  key={p.key}
                  href={presetHref(p.fromIso, p.toIso)}
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

          <div className="flex flex-wrap items-center gap-3">
            <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

            <div
              role="tablist"
              aria-label="Call direction"
              className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card"
            >
              {directionTabs.map((t) => (
                <Link
                  key={t.key}
                  role="tab"
                  aria-selected={direction === t.key}
                  href={directionHref(t.key)}
                  className={
                    direction === t.key
                      ? 'inline-flex items-center rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm'
                      : 'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                  }
                >
                  {t.label}
                </Link>
              ))}
            </div>

            <div
              role="tablist"
              aria-label="Provider"
              className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card"
            >
              {providerTabs.map((t) => (
                <Link
                  key={t.key}
                  role="tab"
                  aria-selected={provider === t.key}
                  href={providerHref(t.key)}
                  className={
                    provider === t.key
                      ? 'inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm'
                      : 'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                  }
                >
                  {t.label}
                </Link>
              ))}
            </div>
          </div>

          {/* Cold-calling KPIs — outbound-first-touch */}
          {data.coldCalling.calls > 0 ? (
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiTile
                label="Cold calls"
                value={String(data.coldCalling.calls)}
                tone="info"
                hint="Outbound, first touch"
              />
              <KpiTile
                label="Cold connect rate"
                value={fmtPct(data.coldCalling.connectRate)}
                tone={data.coldCalling.connectRate >= 0.3 ? 'success' : 'warn'}
                hint="Picked up"
              />
              <KpiTile
                label="Cold talk time"
                value={fmtDuration(data.coldCalling.talkSec)}
                hint="Total minutes on cold calls"
              />
              <KpiTile
                label="Provider mix"
                value={`${data.providerMix.aircall} / ${data.providerMix.google_voice}`}
                hint="Aircall / Google Voice"
              />
            </section>
          ) : null}

          {/* KPIs with period-over-period deltas */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label="Total calls"
              value={String(data.kpis.total)}
              delta={fmtSignedInt(data.deltas.total)}
              tone="info"
              deltaDir="up_is_good"
            />
            <KpiTile
              label="Answered"
              value={String(data.kpis.answered)}
              hint={fmtPct(data.kpis.answeredRate)}
              delta={fmtSignedPct(data.deltas.answeredRate)}
              tone={data.kpis.answeredRate >= 0.7 ? 'success' : 'warn'}
              deltaDir="up_is_good"
            />
            <KpiTile
              label="Voicemails"
              value={String(data.kpis.voicemails)}
              delta={fmtSignedInt(data.deltas.voicemails)}
              tone={data.kpis.voicemails > 0 ? 'warn' : 'neutral'}
              deltaDir="up_is_bad"
            />
            <KpiTile
              label="Missed"
              value={String(data.kpis.missed)}
              delta={fmtSignedInt(data.deltas.missed)}
              tone={data.kpis.missed > 0 ? 'danger' : 'neutral'}
              deltaDir="up_is_bad"
            />
            <KpiTile
              label="Inbound"
              value={String(data.kpis.inbound)}
              delta={fmtSignedInt(data.deltas.inbound)}
            />
            <KpiTile
              label="Outbound"
              value={String(data.kpis.outbound)}
              delta={fmtSignedInt(data.deltas.outbound)}
            />
            <KpiTile
              label="Avg duration"
              value={fmtDuration(data.kpis.avgDurationSec)}
              hint="Answered calls only"
              delta={fmtDuration(data.deltas.avgDurationSec)}
              deltaDir="neutral"
            />
            <KpiTile
              label="Total talk time"
              value={fmtDuration(data.kpis.totalTalkSec)}
              delta={fmtDuration(data.deltas.totalTalkSec)}
              deltaDir="up_is_good"
            />
          </div>

          {/* Daily trend with direction split */}
          <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Daily calls
            </h2>
            {data.daily.counts.some((n) => n > 0) ? (
              <LineChart
                title="Daily call volume across the selected period"
                description="Line chart of daily call counts, split by inbound and outbound."
                xLabels={data.daily.labels.map(shortDayLabel)}
                series={trendSeries}
              />
            ) : (
              <p className="py-12 text-center text-sm text-neutral-500">
                No calls in this period.
              </p>
            )}
          </section>

          {/* Weekly call hours — answers "how busy is the line?" */}
          <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
                Weekly call hours
              </h2>
              <span className="font-mono text-xs tabular-nums text-neutral-500">
                {(data.weekly.hours.reduce((s, n) => s + n, 0)).toFixed(1)}h total ·{' '}
                {data.weekly.calls.reduce((s, n) => s + n, 0)} calls
              </span>
            </div>
            <WeeklyHoursBars
              weekStarts={data.weekly.labels}
              hours={data.weekly.hours}
              calls={data.weekly.calls}
            />
          </section>

          {/* Peak heatmap + hourly throughput side-by-side on lg */}
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
                Peak times
              </h2>
              <p className="mb-3 text-xs text-neutral-500">
                Each cell is a day × hour bucket. Darker cells mean more calls landed there.
              </p>
              <PeakHeatmap peak={data.peak} />
            </section>

            <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
                Hourly throughput
              </h2>
              <p className="mb-3 text-xs text-neutral-500">
                Total calls per hour-of-day across the whole period.
              </p>
              <HourlyBars hourly={data.hourly} />
            </section>
          </div>

          {/* Duration distribution */}
          <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Call duration distribution
            </h2>
            <p className="mb-3 text-xs text-neutral-500">
              How long answered calls actually run.
            </p>
            <DurationBars buckets={data.durationBuckets} />
          </section>

          {/* Missed + voicemail trays side-by-side */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <div className="border-b border-neutral-100 bg-rose-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold text-neutral-900">
                  Recent missed calls
                </h2>
                <p className="text-xs text-neutral-500">Worth a callback.</p>
              </div>
              <div className="px-4 py-2">
                <TrayList rows={data.missedTray} emptyText="No missed calls in this period." />
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-neutral-100 bg-amber-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold text-neutral-900">
                  Recent voicemails
                </h2>
                <p className="text-xs text-neutral-500">Pending follow-up.</p>
              </div>
              <div className="px-4 py-2">
                <TrayList rows={data.voicemailTray} emptyText="No voicemails in this period." />
              </div>
            </Card>
          </div>

          {/* Top contacts */}
          <Card className="overflow-hidden">
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
          </Card>
        </div>
      </PageBody>
    </>
  )
}
