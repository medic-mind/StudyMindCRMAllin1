// Summer Camps — live, read-only view for the sales team. Mirrors the camp
// app's "which camps are running and how full are they" picture: a camps
// roster with booking fill, plus the subject × week fill grid. Data is pulled
// live from camp.studymind.co.uk via the summer-camp integration (no copy in
// our DB). CLAUDE.md §26 (RSC by default; URL state for the year).

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { BackfillButton } from './BackfillButton'

export const dynamic = 'force-dynamic'

const BACKFILL_ROLES = new Set(['ceo', 'senior_manager'])

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(d)
}

function NotConnected() {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center">
      <p className="text-sm font-medium text-neutral-800">Summer Camp app not connected</p>
      <p className="mt-1 text-sm text-neutral-500">
        Set <code className="rounded bg-neutral-100 px-1">SUMMER_CAMP_API_URL</code> and{' '}
        <code className="rounded bg-neutral-100 px-1">SUMMER_CAMP_API_KEY</code> to show the live
        camp roster and fill levels here.
      </p>
    </div>
  )
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
        subtitle="Live view of which camps are running and how full they are. Read-only — bookings are managed in the Summer Camp app."
      />
      <PageBody>
        <div className="mb-4">
          <a
            href="/camps/instalments"
            className="inline-flex items-center gap-1 rounded-md border border-primary-300 bg-white px-3 py-1.5 text-sm font-medium text-primary-700 hover:bg-primary-50"
          >
            Instalments tracker →
          </a>
        </div>
        {!res.connected || !res.feed ? (
          <NotConnected />
        ) : (
          <CampsContent feed={res.feed} year={year} canBackfill={canBackfill} />
        )}
      </PageBody>
    </>
  )
}

type Feed = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof createServerCaller>>['summerCamp']['camps']>>['feed']
>

function CampsContent({
  feed,
  year,
  canBackfill,
}: {
  feed: Feed
  year: number
  canBackfill: boolean
}) {
  return (
    <div className="flex flex-col gap-8">
      {/* Year switcher (URL state) + admin backfill */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500">Year</span>
        {[year - 1, year, year + 1].map((y) => (
          <a
            key={y}
            href={`/camps?year=${y}`}
            className={
              y === year
                ? 'rounded-md bg-primary-600 px-2.5 py-1 font-medium text-white'
                : 'rounded-md px-2.5 py-1 text-neutral-600 hover:bg-neutral-100'
            }
          >
            {y}
          </a>
        ))}
        <span className="ml-auto text-neutral-500">
          {feed.totals.grand} booking{feed.totals.grand === 1 ? '' : 's'} across {feed.camps.length}{' '}
          camp
          {feed.camps.length === 1 ? '' : 's'}
        </span>
        {canBackfill ? <BackfillButton /> : null}
      </div>

      {/* Camps running */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-800">Camps running</h2>
        {feed.camps.length === 0 ? (
          <p className="text-sm text-neutral-500">No camps found for {year}.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {feed.camps.map((c) => (
              <div key={c.id} className="rounded-lg border border-neutral-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-neutral-900">{c.name}</p>
                    <p className="text-xs text-neutral-500">
                      {fmtDate(c.start_date)} – {fmtDate(c.end_date)}
                      {c.location ? ` · ${c.location}` : ''}
                    </p>
                  </div>
                  {c.status ? (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-600">
                      {c.status}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex items-baseline gap-3">
                  <span className="text-2xl font-semibold tabular-nums text-neutral-900">
                    {c.bookings.total}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {c.bookings.confirmed} confirmed · {c.bookings.pending} pending ·{' '}
                    {c.bookings.waitlist} waitlist
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-neutral-400">
                  B2C {c.bookings.b2c} · B2B {c.bookings.b2b} · Agent {c.bookings.agent}
                </div>
                <a
                  href={`/camps/timetable?camp_id=${encodeURIComponent(c.id)}`}
                  className="mt-3 inline-block text-xs font-medium text-primary-700 hover:text-primary-800"
                >
                  View schedule →
                </a>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
