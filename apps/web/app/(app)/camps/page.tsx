// Summer Camps — season overview. Year-scoped (the camp app's feed now scopes
// camps to the requested year and returns available_years for real tabs), with
// a camp-app-style stat strip, tonal status pills, and per-camp fill bars.
// CLAUDE.md §26 (RSC by default; URL state for the year).

import Link from 'next/link'

import { getCurrentUser } from '@/lib/auth/server'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertTriangleIcon,
  CalendarIcon,
  CheckCircleIcon,
  UsersIcon,
} from '@/components/ui/icon'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'
import { cn } from '@/lib/cn'

import { BackfillButton } from './BackfillButton'
import { CampsNav } from './CampsNav'
import { CampStatusBadge, FillBar } from './camp-status'
import { StatTile } from './StatTile'

export const dynamic = 'force-dynamic'

const BACKFILL_ROLES = new Set(['ceo', 'senior_manager'])

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d)
}

export default async function CampsPage({ searchParams }: { searchParams?: { year?: string } }) {
  const year =
    searchParams?.year && /^\d{4}$/.test(searchParams.year)
      ? parseInt(searchParams.year, 10)
      : new Date().getFullYear()

  const [me, caller] = await Promise.all([getCurrentUser(), createServerCaller()])
  const res = await caller.summerCamp.camps({ year })
  const canBackfill = Boolean(me && BACKFILL_ROLES.has(me.role))

  return (
    <>
      <PageHeader
        title="Summer Camps"
        subtitle="The season at a glance — camps running, how full they are, and where each booking sits."
        actions={canBackfill ? <BackfillButton /> : undefined}
      />
      <PageBody>
        <CampsNav />
        {!res.connected || !res.feed ? (
          <Card variant="dashed" className="p-10 text-center">
            <CalendarIcon size={40} className="mx-auto text-neutral-200" />
            <p className="mt-3 text-sm font-medium text-neutral-800">Summer Camp app not connected</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
              Generate the connection keys in the camp app (Admin → Integrations → StudyMind CRM)
              and paste them into this CRM&apos;s environment to see the live season here.
            </p>
          </Card>
        ) : (
          <CampsContent feed={res.feed} year={year} />
        )}
      </PageBody>
    </>
  )
}

type Feed = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof createServerCaller>>['summerCamp']['camps']>>['feed']
>

function YearChips({ years, active, base }: { years: number[]; active: number; base: string }) {
  const all = Array.from(new Set([...years, active])).sort((a, b) => a - b)
  return (
    <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Season year">
      {all.map((y) => (
        <Link
          key={y}
          href={`${base}?year=${y}`}
          aria-current={y === active ? 'page' : undefined}
          className={cn(
            'rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors',
            y === active
              ? 'border-primary-200 bg-primary-50 text-primary-700'
              : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-900',
          )}
        >
          {y}
        </Link>
      ))}
    </div>
  )
}

function CampsContent({ feed, year }: { feed: Feed; year: number }) {
  const sums = feed.camps.reduce(
    (acc, c) => ({
      total: acc.total + c.bookings.total,
      confirmed: acc.confirmed + c.bookings.confirmed,
      pending: acc.pending + c.bookings.pending,
      waitlist: acc.waitlist + c.bookings.waitlist,
    }),
    { total: 0, confirmed: 0, pending: 0, waitlist: 0 },
  )

  return (
    <div className="flex flex-col gap-6">
      <YearChips years={feed.available_years ?? []} active={year} base="/camps" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={<CalendarIcon size={18} />} tone="primary" label={`Camps in ${year}`} value={feed.camps.length} />
        <StatTile icon={<UsersIcon size={18} />} tone="info" label="Bookings" value={sums.total} />
        <StatTile icon={<CheckCircleIcon size={18} />} tone="success" label="Confirmed" value={sums.confirmed} />
        <StatTile icon={<AlertTriangleIcon size={18} />} tone="warn" label="Pending" value={sums.pending} />
      </div>

      {feed.camps.length === 0 ? (
        <Card variant="dashed" className="p-10 text-center">
          <CalendarIcon size={40} className="mx-auto text-neutral-200" />
          <p className="mt-3 text-sm font-medium text-neutral-800">No camps in {year}</p>
          <p className="mt-1 text-sm text-neutral-500">
            Camps appear here once they are created (with dates) in the Summer Camp app.
          </p>
        </Card>
      ) : (
        <section aria-label={`Camps running in ${year}`} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {feed.camps.map((c) => (
            <Card key={c.id} className="flex flex-col transition-shadow hover:shadow-md">
              <CardHeader>
                <CardTitle>{c.name}</CardTitle>
                <CampStatusBadge status={c.status} />
              </CardHeader>
              <CardBody className="flex-1">
                <p className="text-xs text-neutral-500">
                  {fmtDate(c.start_date)} – {fmtDate(c.end_date)}
                  {c.location ? ` · ${c.location}` : ''}
                </p>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-bold tabular-nums text-neutral-900">{c.bookings.total}</span>
                  <span className="text-xs text-neutral-500">booking{c.bookings.total === 1 ? '' : 's'}</span>
                </div>
                <div className="mt-2">
                  <FillBar
                    confirmed={c.bookings.confirmed}
                    pending={c.bookings.pending}
                    waitlist={c.bookings.waitlist}
                    total={c.bookings.total}
                  />
                  <p className="mt-1.5 text-[11px] text-neutral-500">
                    <span className="font-medium text-emerald-700">{c.bookings.confirmed} confirmed</span>
                    {' · '}
                    <span className="font-medium text-amber-700">{c.bookings.pending} pending</span>
                    {' · '}
                    <span className="font-medium text-sky-700">{c.bookings.waitlist} waitlist</span>
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {c.bookings.b2c > 0 ? <Badge tone="neutral">B2C {c.bookings.b2c}</Badge> : null}
                  {c.bookings.b2b > 0 ? <Badge tone="neutral">B2B {c.bookings.b2b}</Badge> : null}
                  {c.bookings.agent > 0 ? <Badge tone="neutral">Agent {c.bookings.agent}</Badge> : null}
                </div>
              </CardBody>
              <CardFooter className="gap-2">
                <Link
                  href={`/camps/timetable?camp_id=${encodeURIComponent(c.id)}&year=${year}`}
                  className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
                >
                  Schedule
                </Link>
                <Link
                  href={`/camps/bookings?camp=${encodeURIComponent(c.id)}&year=${year}`}
                  className="rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
                >
                  Bookings
                </Link>
              </CardFooter>
            </Card>
          ))}
        </section>
      )}
    </div>
  )
}
