// Summer Camps — schedule, organised per YEAR → CAMP → DAY (camp-app style).
// Year chips scope the season, camp chips pick one camp, day chips jump within
// it. No more every-camp-ever stacked on one endless page. Read-only — the
// schedule itself is managed in the Summer Camp app. CLAUDE.md §26.

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar } from '@/components/ui/avatar'
import { CalendarIcon } from '@/components/ui/icon'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'
import { cn } from '@/lib/cn'

import { CampsNav } from '../CampsNav'
import { CampStatusBadge } from '../camp-status'

export const dynamic = 'force-dynamic'

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(d)
}
function fmtShortDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d)
}
function fmtTime(t: string | null): string {
  if (!t) return ''
  return t.length >= 5 ? t.slice(0, 5) : t // Postgres TIME "HH:MM:SS" → "HH:MM"
}

export default async function TimetablePage({
  searchParams,
}: {
  searchParams?: { camp_id?: string; year?: string }
}) {
  const year =
    searchParams?.year && /^\d{4}$/.test(searchParams.year)
      ? parseInt(searchParams.year, 10)
      : new Date().getFullYear()
  const campId = searchParams?.camp_id ?? null

  const caller = await createServerCaller()
  const [campsRes, timetableRes] = await Promise.all([
    caller.summerCamp.camps({ year }).catch(() => null),
    caller.summerCamp.timetable({ ...(campId ? { campId } : {}), year }).catch(() => null),
  ])

  const connected = Boolean(timetableRes?.connected && timetableRes.feed)

  return (
    <>
      <PageHeader
        title="Camp schedule"
        subtitle="The day-by-day timetable exactly as students see it, organised by season. Read-only — schedules are managed in the Summer Camp app."
      />
      <PageBody>
        <CampsNav />
        {!connected ? (
          <Card variant="dashed" className="p-10 text-center">
            <CalendarIcon size={40} className="mx-auto text-neutral-200" />
            <p className="mt-3 text-sm font-medium text-neutral-800">Summer Camp app not connected</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              Connect the camp app (see the Overview page) to browse each camp&apos;s schedule here.
            </p>
          </Card>
        ) : (
          <ScheduleContent
            feed={timetableRes!.feed!}
            years={campsRes?.feed?.available_years ?? [year]}
            year={year}
            campId={campId}
          />
        )}
      </PageBody>
    </>
  )
}

type Feed = NonNullable<
  NonNullable<
    Awaited<ReturnType<Awaited<ReturnType<typeof createServerCaller>>['summerCamp']['timetable']>>
  >['feed']
>
type Camp = Feed['camps'][number]

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'border-primary-200 bg-primary-50 text-primary-700'
          : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900',
      )}
    >
      {children}
    </Link>
  )
}

function ScheduleContent({
  feed,
  years,
  year,
  campId,
}: {
  feed: Feed
  years: number[]
  year: number
  campId: string | null
}) {
  const allYears = Array.from(new Set([...years, year])).sort((a, b) => a - b)
  const selected = campId ? (feed.camps.find((c) => c.id === campId) ?? null) : null

  return (
    <div className="flex flex-col gap-5">
      {/* Year → camp navigation */}
      <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Season year">
        {allYears.map((y) => (
          <Chip key={y} href={`/camps/timetable?year=${y}`} active={y === year}>
            {y}
          </Chip>
        ))}
      </div>
      {feed.camps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Camp">
          <Chip href={`/camps/timetable?year=${year}`} active={!campId}>
            All camps
          </Chip>
          {feed.camps.map((c) => (
            <Chip
              key={c.id}
              href={`/camps/timetable?year=${year}&camp_id=${encodeURIComponent(c.id)}`}
              active={campId === c.id}
            >
              {c.name}
              {c.start_date ? (
                <span className="ml-1.5 text-xs font-normal text-neutral-400">
                  {fmtShortDate(c.start_date)}
                  {c.end_date ? `–${fmtShortDate(c.end_date)}` : ''}
                </span>
              ) : null}
            </Chip>
          ))}
        </div>
      ) : null}

      {feed.camps.length === 0 ? (
        <Card variant="dashed" className="p-10 text-center">
          <CalendarIcon size={40} className="mx-auto text-neutral-200" />
          <p className="mt-3 text-sm font-medium text-neutral-800">No camp schedules in {year}</p>
          <p className="mt-1 text-sm text-neutral-500">
            Schedules appear here once camps (with days) exist in the Summer Camp app for this year.
          </p>
        </Card>
      ) : selected ? (
        <CampSchedule camp={selected} />
      ) : (
        <section aria-label="Camps" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {feed.camps.map((c) => (
            <Card key={c.id} className="flex flex-col transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle>{c.name}</CardTitle>
                <CampStatusBadge status={c.status} />
              </CardHeader>
              <CardBody className="flex-1 text-sm text-neutral-600">
                <p className="text-xs text-neutral-500">
                  {fmtShortDate(c.start_date)} – {fmtShortDate(c.end_date)}
                  {c.location ? ` · ${c.location}` : ''}
                </p>
                <p className="mt-2">
                  {c.days.length} day{c.days.length === 1 ? '' : 's'} scheduled ·{' '}
                  {c.days.reduce((n, d) => n + d.entries.length, 0)} sessions
                </p>
              </CardBody>
              <CardFooter>
                <Link
                  href={`/camps/timetable?year=${year}&camp_id=${encodeURIComponent(c.id)}`}
                  className="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-primary-700"
                >
                  View schedule
                </Link>
              </CardFooter>
            </Card>
          ))}
        </section>
      )}
    </div>
  )
}

function CampSchedule({ camp }: { camp: Camp }) {
  const hasArrival = camp.arrival_time || camp.arrival_location || camp.arrival_notes || camp.arrival_bring

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{camp.name}</CardTitle>
            <p className="mt-0.5 text-xs text-neutral-500">
              {fmtDate(camp.start_date)} – {fmtDate(camp.end_date)}
              {camp.location ? ` · ${camp.location}` : ''}
            </p>
          </div>
          <CampStatusBadge status={camp.status} />
        </CardHeader>
        {hasArrival ? (
          <CardBody>
            <div className="rounded-lg bg-sky-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-sky-800">
                Arrival
              </p>
              <dl className="mt-1.5 grid gap-x-6 gap-y-1 text-sm text-sky-900 sm:grid-cols-2">
                {camp.arrival_time ? (
                  <div>
                    <dt className="inline font-medium">Time: </dt>
                    <dd className="inline">{fmtTime(camp.arrival_time)}</dd>
                  </div>
                ) : null}
                {camp.arrival_location ? (
                  <div>
                    <dt className="inline font-medium">Meeting point: </dt>
                    <dd className="inline">{camp.arrival_location}</dd>
                  </div>
                ) : null}
                {camp.arrival_bring ? (
                  <div className="sm:col-span-2">
                    <dt className="inline font-medium">Bring: </dt>
                    <dd className="inline">{camp.arrival_bring}</dd>
                  </div>
                ) : null}
                {camp.arrival_notes ? (
                  <div className="sm:col-span-2">
                    <dt className="inline font-medium">Notes: </dt>
                    <dd className="inline">{camp.arrival_notes}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </CardBody>
        ) : null}
      </Card>

      {camp.days.length > 3 ? (
        <div className="flex flex-wrap gap-1.5" role="navigation" aria-label="Jump to day">
          {camp.days.map((d, i) => (
            <a
              key={d.id}
              href={`#day-${i + 1}`}
              className="rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
            >
              {d.label ?? `Day ${d.day_number ?? i + 1}`}
            </a>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {camp.days.map((day, i) => (
          <Card key={day.id} id={`day-${i + 1}`} className="scroll-mt-24">
            <CardHeader>
              <CardTitle>
                {day.label ?? `Day ${day.day_number ?? i + 1}`}
                {day.date ? (
                  <span className="ml-2 font-normal text-neutral-500">{fmtDate(day.date)}</span>
                ) : null}
              </CardTitle>
              <span className="text-xs text-neutral-400">
                {day.entries.length} session{day.entries.length === 1 ? '' : 's'}
              </span>
            </CardHeader>
            <CardBody className="p-3">
              {day.entries.length === 0 ? (
                <p className="rounded-lg border border-dashed border-neutral-200 p-4 text-center text-sm text-neutral-500">
                  No sessions scheduled for this day yet.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {day.entries.map((entry, j) => (
                    <li key={j} className="flex gap-3 rounded-lg bg-neutral-50/70 px-3 py-2">
                      <span className="w-24 shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-neutral-600">
                        {fmtTime(entry.start_time)}
                        {entry.end_time ? `–${fmtTime(entry.end_time)}` : ''}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-neutral-900">
                          {entry.title ?? entry.subject ?? 'Session'}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          {entry.session_type ? <Badge tone="info">{entry.session_type}</Badge> : null}
                          {entry.is_field_trip ? <Badge tone="warn">Field trip</Badge> : null}
                          {entry.room_number ? <Badge tone="neutral">Room {entry.room_number}</Badge> : null}
                          {entry.location ? <Badge tone="neutral">{entry.location}</Badge> : null}
                          {entry.tutor ? (
                            <span className="inline-flex items-center gap-1 text-xs text-neutral-600">
                              <Avatar name={entry.tutor} size={18} />
                              {entry.tutor}
                            </span>
                          ) : null}
                        </span>
                        {entry.what_to_bring ? (
                          <span className="mt-1 block text-[11px] text-neutral-500">
                            Bring: {entry.what_to_bring}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  )
}
