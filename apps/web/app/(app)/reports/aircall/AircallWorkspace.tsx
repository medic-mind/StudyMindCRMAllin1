'use client'

// Aircall analytics workspace. Replaces the old full-page-reload report: every
// control used to be a <Link> that re-ran the whole RSC page (a heavy server
// recompute per click, no pending feedback — "the buttons don't work"). Now
// the filters are local state driving ONE cached tRPC query
// (reports.aircall.summary): clicks respond instantly, the previous data stays
// on screen while the next loads (placeholderData), revisited filter combos
// are served from the client cache, and the URL stays shareable via
// router.replace. CLAUDE.md §26 (client leaf), §10.

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

import { InteractiveLineChart } from '@/components/charts/interactive-line-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DownloadIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { trpc, type RouterOutputs } from '@/lib/trpc/client'

import { buildPeriodPresets } from '../period'
import { PeakWindowsManager } from './PeakWindowsManager'

type Direction = 'all' | 'inbound' | 'outbound'
type Provider = 'all' | 'aircall' | 'google_voice' | 'manual'
type View = 'overview' | 'peak' | 'performance'

interface Props {
  initial: { fromIso: string; toIso: string; direction: Direction; provider: Provider; view: View }
  canManage: boolean
}

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
  const sign = sec < 0 ? '-' : ''
  const abs = Math.abs(sec)
  const m = Math.floor(abs / 60)
  const s = abs % 60
  if (m >= 60) return `${sign}${Math.floor(m / 60)}h ${m % 60}m`
  return `${sign}${m}:${String(s).padStart(2, '0')}`
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

export function AircallWorkspace({ initial, canManage }: Props) {
  const router = useRouter()
  const pathname = usePathname() ?? '/reports/aircall'
  const utils = trpc.useUtils()

  const [fromIso, setFromIso] = useState(initial.fromIso)
  const [toIso, setToIso] = useState(initial.toIso)
  // Draft custom dates (applied on "Update" so half-typed dates don't fire).
  const [draftFrom, setDraftFrom] = useState(initial.fromIso)
  const [draftTo, setDraftTo] = useState(initial.toIso)
  const [direction, setDirection] = useState<Direction>(initial.direction)
  const [provider, setProvider] = useState<Provider>(initial.provider)
  const [view, setView] = useState<View>(initial.view)

  const queryInput = useMemo(
    () => ({
      from: new Date(`${fromIso}T00:00:00.000Z`),
      to: new Date(`${toIso}T00:00:00.000Z`),
      direction,
      provider,
    }),
    [fromIso, toIso, direction, provider],
  )

  const summary = trpc.reports.aircall.summary.useQuery(queryInput, {
    // Keep the last result on screen while the next filter combo loads — the
    // page never blanks and every click gives instant visual response.
    placeholderData: (prev) => prev,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const data = summary.data

  // Keep the URL shareable/bookmarkable without triggering a server render.
  function syncUrl(next: { fromIso?: string; toIso?: string; direction?: Direction; provider?: Provider; view?: View }) {
    const q = new URLSearchParams()
    q.set('from', next.fromIso ?? fromIso)
    q.set('to', next.toIso ?? toIso)
    const d = next.direction ?? direction
    if (d !== 'all') q.set('direction', d)
    const p = next.provider ?? provider
    if (p !== 'all') q.set('provider', p)
    const v = next.view ?? view
    if (v !== 'overview') q.set('view', v)
    router.replace(`${pathname}?${q.toString()}`, { scroll: false })
  }

  function setPeriod(nextFrom: string, nextTo: string) {
    setFromIso(nextFrom)
    setToIso(nextTo)
    setDraftFrom(nextFrom)
    setDraftTo(nextTo)
    syncUrl({ fromIso: nextFrom, toIso: nextTo })
  }

  const presets = useMemo(() => buildPeriodPresets(), [])
  const activePreset = presets.find((p) => p.fromIso === fromIso && p.toIso === toIso)

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
  const viewTabs: Array<{ key: View; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'peak', label: 'Peak times' },
    { key: 'performance', label: 'Performance' },
  ]

  const pdfQuery = new URLSearchParams({ from: fromIso, to: toIso })
  if (direction !== 'all') pdfQuery.set('direction', direction)
  if (provider !== 'all') pdfQuery.set('provider', provider)
  const pdfHref = `/api/reports/aircall/pdf?${pdfQuery.toString()}`

  const segmented = (active: boolean) =>
    active
      ? 'inline-flex items-center rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm'
      : 'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900'

  if (summary.error) {
    const forbidden = summary.error.data?.code === 'FORBIDDEN'
    return (
      <Card className="p-8 text-center text-sm text-neutral-600">
        {forbidden
          ? 'This report is for Manager and above.'
          : 'Could not load the report just now.'}
        {!forbidden && (
          <div className="mt-3">
            <Button type="button" size="sm" variant="secondary" onClick={() => summary.refetch()}>
              Retry
            </Button>
          </div>
        )}
      </Card>
    )
  }

  return (
    <div className="relative space-y-6">
      {/* Live progress shimmer — instant feedback on every filter click. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -top-3 left-0 right-0 h-0.5 overflow-hidden rounded-full transition-opacity ${summary.isFetching ? 'opacity-100' : 'opacity-0'}`}
      >
        <div className="h-full w-1/3 animate-pulse rounded-full bg-primary-500" />
      </div>

      {/* Controls */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map((p) => {
            const active = activePreset?.key === p.key
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={active}
                onClick={() => setPeriod(p.fromIso, p.toIso)}
                className={
                  active
                    ? 'inline-flex items-center rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white shadow-sm'
                    : 'inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900'
                }
              >
                {p.label}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (draftFrom && draftTo) setPeriod(draftFrom, draftTo)
            }}
          >
            <label className="flex flex-col text-xs text-neutral-600">
              From
              <Input
                type="date"
                value={draftFrom}
                max={draftTo}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
            </label>
            <label className="flex flex-col text-xs text-neutral-600">
              To
              <Input
                type="date"
                value={draftTo}
                min={draftFrom}
                onChange={(e) => setDraftTo(e.target.value)}
              />
            </label>
            <Button type="submit" variant="secondary">
              Update
            </Button>
          </form>
          <div
            role="tablist"
            aria-label="Call direction"
            className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5"
          >
            {directionTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={direction === t.key}
                onClick={() => {
                  setDirection(t.key)
                  syncUrl({ direction: t.key })
                }}
                className={segmented(direction === t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div
            role="tablist"
            aria-label="Provider"
            className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5"
          >
            {providerTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={provider === t.key}
                onClick={() => {
                  setProvider(t.key)
                  syncUrl({ provider: t.key })
                }}
                className={
                  provider === t.key
                    ? 'inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm'
                    : 'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <a
            href={pdfHref}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 shadow-card transition-colors hover:bg-neutral-50"
          >
            <DownloadIcon size={15} className="text-neutral-500" />
            Export PDF
          </a>
        </div>
      </Card>

      {!data ? (
        <SkeletonReport />
      ) : (
        <ReportBody
          data={data}
          view={view}
          viewTabs={viewTabs}
          onView={(v) => {
            setView(v)
            syncUrl({ view: v })
          }}
          segmented={segmented}
          canManage={canManage}
          onPeakWindowsChanged={() => void utils.reports.aircall.summary.invalidate()}
        />
      )}
    </div>
  )
}

type SummaryData = RouterOutputs['reports']['aircall']['summary']

function ReportBody({
  data,
  view,
  viewTabs,
  onView,
  segmented,
  canManage,
  onPeakWindowsChanged,
}: {
  data: SummaryData
  view: View
  viewTabs: Array<{ key: View; label: string }>
  onView: (v: View) => void
  segmented: (active: boolean) => string
  canManage: boolean
  onPeakWindowsChanged: () => void
}) {
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

  const peakCell: boolean[][] = Array.from({ length: 7 }, () => new Array(24).fill(false))
  for (const w of data.peakWindows) {
    if (w.endHour <= w.startHour) continue
    for (const dow of w.daysOfWeek) {
      if (dow < 0 || dow > 6) continue
      for (let h = w.startHour; h < w.endHour && h < 24; h += 1) {
        const rowCells = peakCell[dow]
        if (rowCells) rowCells[h] = true
      }
    }
  }

  const ps = data.peakStats
  const busiestLabel = ps.busiest
    ? `${DOW_LABELS[ps.busiest.dow]} ${String(ps.busiest.hour).padStart(2, '0')}:00`
    : '—'

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Total calls"
          value={String(data.kpis.total)}
          hint={`${data.kpis.inbound} in · ${data.kpis.outbound} out`}
          delta={fmtSignedInt(data.deltas.total)}
          tone="info"
        />
        <KpiTile
          label="Answered"
          value={String(data.kpis.answered)}
          hint={fmtPct(data.kpis.answeredRate)}
          delta={fmtSignedPct(data.deltas.answeredRate)}
          tone={data.kpis.answeredRate >= 0.7 ? 'success' : 'warn'}
        />
        <KpiTile
          label="Missed"
          value={String(data.kpis.missed)}
          delta={fmtSignedInt(data.deltas.missed)}
          tone={data.kpis.missed > 0 ? 'danger' : 'neutral'}
          deltaDir="up_is_bad"
        />
        <KpiTile
          label="Voicemails"
          value={String(data.kpis.voicemails)}
          delta={fmtSignedInt(data.deltas.voicemails)}
          tone={data.kpis.voicemails > 0 ? 'warn' : 'neutral'}
          deltaDir="up_is_bad"
        />
        <KpiTile
          label="Avg duration"
          value={fmtDuration(data.kpis.avgDurationSec)}
          hint="Answered only"
          delta={fmtDuration(data.deltas.avgDurationSec)}
          deltaDir="neutral"
        />
        <KpiTile
          label="Talk time"
          value={fmtDuration(data.kpis.totalTalkSec)}
          delta={fmtDuration(data.deltas.totalTalkSec)}
        />
      </div>

      <div
        role="tablist"
        aria-label="Report view"
        className="inline-flex items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-card"
      >
        {viewTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={view === t.key}
            onClick={() => onView(t.key)}
            className={segmented(view === t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'overview' ? (
        <div className="space-y-6">
          <Card className="p-4">
            <SectionTitle hint="Hover (or use ←/→ when focused) for the exact counts per day.">
              Daily calls
            </SectionTitle>
            {data.daily.counts.some((n) => n > 0) ? (
              <InteractiveLineChart
                title="Daily call volume across the selected period"
                xLabels={data.daily.labels.map(shortDayLabel)}
                series={trendSeries}
              />
            ) : (
              <p className="py-12 text-center text-sm text-neutral-500">
                No calls in this period.
              </p>
            )}
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <div className="flex items-start justify-between gap-2 border-b border-neutral-100 bg-rose-50/60 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold text-neutral-900">Recent missed calls</h2>
                  <p className="text-xs text-neutral-500">Worth a callback.</p>
                </div>
                <Link
                  href="/calls"
                  className="shrink-0 text-xs font-medium text-primary-700 hover:underline"
                >
                  Missed-calls queue →
                </Link>
              </div>
              <div className="px-4 py-2">
                <TrayList rows={data.missedTray} emptyText="No missed calls in this period." />
              </div>
            </Card>
            <Card className="overflow-hidden">
              <div className="border-b border-neutral-100 bg-amber-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold text-neutral-900">Recent voicemails</h2>
                <p className="text-xs text-neutral-500">Pending follow-up.</p>
              </div>
              <div className="px-4 py-2">
                <TrayList rows={data.voicemailTray} emptyText="No voicemails in this period." />
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {view === 'peak' ? (
        <div className="space-y-6">
          {ps.configured ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiTile
                label="Calls in peak"
                value={String(ps.peakCalls)}
                hint={`${fmtPct(ps.peakShare)} of all calls`}
                tone="info"
              />
              <KpiTile
                label="Peak answered rate"
                value={fmtPct(ps.peakAnsweredRate)}
                tone={ps.peakAnsweredRate >= 0.7 ? 'success' : 'warn'}
              />
              <KpiTile
                label="Off-peak answered"
                value={fmtPct(ps.offPeakAnsweredRate)}
                hint={`${ps.offPeakCalls} calls`}
              />
              <KpiTile
                label="Busiest peak slot"
                value={busiestLabel}
                hint={ps.busiest ? `${ps.busiest.count} calls` : undefined}
                tone="warn"
              />
            </div>
          ) : null}

          <Card className="p-4">
            <SectionTitle hint="Each cell is a day × hour bucket (UK time). Darker = more calls; amber outline = a configured peak slot.">
              Peak times heatmap
            </SectionTitle>
            <PeakHeatmap peak={data.peak} peakCell={peakCell} />
          </Card>

          <Card className="p-4">
            <SectionTitle hint="Total calls per hour-of-day across the whole period (UK time).">
              Hourly throughput
            </SectionTitle>
            <HourlyBars hourly={data.hourly} />
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-neutral-100 bg-neutral-50/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-neutral-900">Peak windows</h2>
              <p className="text-xs text-neutral-500">
                Customise which days and times count as peak, across the year.
              </p>
            </div>
            <div className="p-4">
              <PeakWindowsManager
                windows={data.peakWindows.map((w) => {
                  const stat = ps.byWindow.find((b) => b.id === w.id)
                  return {
                    id: w.id,
                    name: w.name,
                    startMonth: w.startMonth,
                    startDay: w.startDay,
                    endMonth: w.endMonth,
                    endDay: w.endDay,
                    daysOfWeek: w.daysOfWeek,
                    startHour: w.startHour,
                    endHour: w.endHour,
                    year: w.year,
                    color: w.color,
                    labels: w.labels,
                    calls: stat?.calls ?? 0,
                    answered: stat?.answered ?? 0,
                  }
                })}
                canManage={canManage}
                onChanged={onPeakWindowsChanged}
              />
            </div>
          </Card>
        </div>
      ) : null}

      {view === 'performance' ? (
        <div className="space-y-6">
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
                hint="Total on cold calls"
              />
              <KpiTile
                label="Provider mix"
                value={`${data.providerMix.aircall} / ${data.providerMix.google_voice}`}
                hint="Aircall / Google Voice"
              />
            </section>
          ) : null}

          <Card className="p-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <SectionTitle>Weekly call hours</SectionTitle>
              <span className="font-mono text-xs tabular-nums text-neutral-500">
                {data.weekly.hours.reduce((s, n) => s + n, 0).toFixed(1)}h ·{' '}
                {data.weekly.calls.reduce((s, n) => s + n, 0)} calls
              </span>
            </div>
            <WeeklyHoursBars
              weekStarts={data.weekly.labels}
              hours={data.weekly.hours}
              calls={data.weekly.calls}
            />
          </Card>

          <Card className="p-4">
            <SectionTitle hint="How long answered calls actually run.">
              Call duration distribution
            </SectionTitle>
            <DurationBars buckets={data.durationBuckets} />
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-neutral-100 bg-neutral-50/60 px-4 py-3">
              <h2 className="text-sm font-semibold text-neutral-900">Top contacts by call volume</h2>
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
                            {c.kind.replace(/_/g, ' ')}
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
      ) : null}
    </>
  )
}

// ── Presentational pieces (ported from the old RSC page) ─────────────────────

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
    const zero = ['+0', '0', '+0%', '0%', '+0:00', '0:00'].includes(delta)
    if (zero || deltaDir === 'neutral') return 'text-neutral-500'
    const good = (deltaDir === 'up_is_good' && positive) || (deltaDir === 'up_is_bad' && !positive)
    return good ? 'text-emerald-700' : 'text-rose-700'
  })()
  return (
    <Card className="relative overflow-hidden p-4 pl-5 transition-shadow hover:shadow-card-hover">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${bar[tone]}`} />
      <p className="truncate text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums text-neutral-900">{value}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {delta ? (
          <span className={`text-xs font-medium tabular-nums ${deltaColor}`}>{delta} vs prev</span>
        ) : null}
        {hint ? <span className="text-xs text-neutral-500">{hint}</span> : null}
      </div>
    </Card>
  )
}

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">{children}</h2>
      {hint ? <p className="mt-0.5 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  )
}

function PeakHeatmap({ peak, peakCell }: { peak: number[][]; peakCell: boolean[][] }) {
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
                const isPeak = peakCell[dow]?.[h] ?? false
                const bg =
                  count === 0
                    ? 'rgb(245 245 250)'
                    : `rgba(147 51 234 / ${Math.max(0.08, intensity).toFixed(2)})`
                return (
                  <td
                    key={h}
                    className="h-6 w-6 rounded-sm"
                    style={{
                      backgroundColor: bg,
                      boxShadow: isPeak ? 'inset 0 0 0 1.5px rgb(245 158 11)' : undefined,
                    }}
                    title={`${DOW_LABELS[dow]} ${String(h).padStart(2, '0')}:00 — ${count} call${count === 1 ? '' : 's'}${isPeak ? ' · peak' : ''}`}
                  >
                    <span className="sr-only">
                      {DOW_LABELS[dow]} {h}:00 — {count} calls{isPeak ? ' (peak)' : ''}
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
                title={`Week of ${shortDayLabel(wk)} — ${h}h on ${c} calls`}
              />
            </div>
            <span className="text-[10px] text-neutral-500">{shortDayLabel(wk)}</span>
          </div>
        )
      })}
    </div>
  )
}

function HourlyBars({ hourly }: { hourly: number[] }) {
  const max = Math.max(1, ...hourly)
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
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
              <div className="h-full rounded-full bg-primary-500" style={{ width: `${pct}%` }} />
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
  if (rows.length === 0)
    return <p className="py-6 text-center text-sm text-neutral-500">{emptyText}</p>
  return (
    <ul className="divide-y divide-neutral-100">
      {rows.map((r) => (
        <li key={r.callId} className="flex items-center gap-3 py-2.5">
          <Avatar name={r.name} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-neutral-900">
              {r.contactId ? (
                <Link
                  href={`/contacts/${r.contactId}`}
                  className="hover:text-primary-700 hover:underline"
                >
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

function SkeletonReport() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading report">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-neutral-200 bg-neutral-100" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-xl border border-neutral-200 bg-neutral-100" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-xl border border-neutral-200 bg-neutral-100" />
        <div className="h-56 animate-pulse rounded-xl border border-neutral-200 bg-neutral-100" />
      </div>
    </div>
  )
}
