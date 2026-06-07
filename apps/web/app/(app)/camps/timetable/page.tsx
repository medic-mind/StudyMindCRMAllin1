// Summer Camps — weekly timetables (read-only). Shows what's running on each
// camp, week by week, so the sales team can answer "what happens on week 2 of
// the Oxford camp?" without leaving the CRM. Pulled live from the camp app.
// CLAUDE.md §26.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(d)
}

function fmtTime(t: string | null): string {
  if (!t) return ''
  // Postgres TIME comes back as "HH:MM:SS"; show "HH:MM".
  return t.length >= 5 ? t.slice(0, 5) : t
}

export default async function TimetablePage({
  searchParams,
}: {
  searchParams?: { camp_id?: string }
}) {
  const caller = await createServerCaller()
  const res = await caller.summerCamp.timetable(
    searchParams?.camp_id ? { campId: searchParams.camp_id } : undefined,
  )

  return (
    <>
      <PageHeader
        title="Camp timetables"
        subtitle="What's running on each camp, week by week. Read-only — schedules are managed in the Summer Camp app."
      />
      <PageBody>
        {!res.connected || !res.feed ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
            Summer Camp app not connected. Set the integration env vars to show timetables here.
          </div>
        ) : res.feed.camps.length === 0 ? (
          <p className="text-sm text-neutral-500">No camp timetables published yet.</p>
        ) : (
          <TimetableContent feed={res.feed} activeCampId={searchParams?.camp_id ?? null} />
        )}
      </PageBody>
    </>
  )
}

type Feed = NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createServerCaller>>['summerCamp']['timetable']>>['feed']>

function TimetableContent({ feed, activeCampId }: { feed: Feed; activeCampId: string | null }) {
  return (
    <div className="flex flex-col gap-6">
      {/* Camp filter tabs */}
      {feed.camps.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <a
            href="/camps/timetable"
            className={
              !activeCampId
                ? 'rounded-md bg-primary-600 px-2.5 py-1 font-medium text-white'
                : 'rounded-md px-2.5 py-1 text-neutral-600 hover:bg-neutral-100'
            }
          >
            All camps
          </a>
          {feed.camps.map((c) => (
            <a
              key={c.id}
              href={`/camps/timetable?camp_id=${encodeURIComponent(c.id)}`}
              className={
                activeCampId === c.id
                  ? 'rounded-md bg-primary-600 px-2.5 py-1 font-medium text-white'
                  : 'rounded-md px-2.5 py-1 text-neutral-600 hover:bg-neutral-100'
              }
            >
              {c.name}
            </a>
          ))}
        </div>
      ) : null}

      {feed.camps.map((camp) => (
        <section key={camp.id} className="rounded-lg border border-neutral-200 bg-white">
          <div className="border-b border-neutral-200 px-4 py-3">
            <p className="font-medium text-neutral-900">{camp.name}</p>
            <p className="text-xs text-neutral-500">
              {fmtDate(camp.start_date)} – {fmtDate(camp.end_date)}
              {camp.location ? ` · ${camp.location}` : ''}
            </p>
          </div>
          <div className="flex flex-col gap-5 p-4">
            {camp.weeks.length === 0 ? (
              <p className="text-sm text-neutral-500">No sessions scheduled.</p>
            ) : (
              camp.weeks.map((week) => (
                <div key={week.week_number}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Week {week.week_number}
                    {week.start_date ? ` · ${fmtDate(week.start_date)}` : ''}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                    {week.days.map((day) => (
                      <div key={day.id} className="rounded-md border border-neutral-200 bg-neutral-50/50 p-2">
                        <p className="mb-1.5 text-xs font-medium text-neutral-700">
                          {day.label || fmtDate(day.date) || `Day ${day.day_number ?? ''}`}
                        </p>
                        {day.entries.length === 0 ? (
                          <p className="text-[11px] text-neutral-400">—</p>
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {day.entries.map((e, i) => (
                              <li
                                key={i}
                                className="rounded bg-white px-1.5 py-1 text-[11px] leading-tight shadow-sm"
                                style={
                                  e.session_colour
                                    ? { borderLeft: `3px solid ${e.session_colour}` }
                                    : undefined
                                }
                              >
                                <div className="font-medium text-neutral-800">
                                  {fmtTime(e.start_time)}
                                  {e.end_time ? `–${fmtTime(e.end_time)}` : ''} {e.title ?? e.subject ?? 'Session'}
                                </div>
                                {(e.tutor || e.location) && (
                                  <div className="text-neutral-500">
                                    {[e.tutor, e.location].filter(Boolean).join(' · ')}
                                  </div>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  )
}
