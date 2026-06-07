// Summer Camps — student-style schedule (read-only). Mirrors what students see
// in their camp pack on camp.studymind.co.uk: per camp, day by day (Day 1, Day
// 2 …), each day's sessions with times, tutor, location and the session-type
// colour, plus the camp's arrival info. Pulled live from the camp app.
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
  return t.length >= 5 ? t.slice(0, 5) : t // Postgres TIME "HH:MM:SS" → "HH:MM"
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
        title="Camp schedule"
        subtitle="The day-by-day timetable exactly as students see it. Read-only — schedules are managed in the Summer Camp app."
      />
      <PageBody>
        {!res.connected || !res.feed ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
            Summer Camp app not connected. Set the integration env vars to show schedules here.
          </div>
        ) : res.feed.camps.length === 0 ? (
          <p className="text-sm text-neutral-500">No camp schedules published yet.</p>
        ) : (
          <TimetableContent feed={res.feed} activeCampId={searchParams?.camp_id ?? null} />
        )}
      </PageBody>
    </>
  )
}

type Feed = NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createServerCaller>>['summerCamp']['timetable']>>['feed']>
type Camp = Feed['camps'][number]

function TimetableContent({ feed, activeCampId }: { feed: Feed; activeCampId: string | null }) {
  return (
    <div className="flex flex-col gap-6">
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
        <CampSchedule key={camp.id} camp={camp} />
      ))}
    </div>
  )
}

function CampSchedule({ camp }: { camp: Camp }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-3">
        <p className="font-medium text-neutral-900">{camp.name}</p>
        <p className="text-xs text-neutral-500">
          {fmtDate(camp.start_date)} – {fmtDate(camp.end_date)}
          {camp.location ? ` · ${camp.location}` : ''}
        </p>
        {(camp.arrival_location || camp.arrival_time || camp.arrival_notes) && (
          <p className="mt-1.5 text-xs text-neutral-600">
            <span className="font-medium text-neutral-700">Arrival:</span>{' '}
            {[
              camp.arrival_time ? fmtTime(camp.arrival_time) : null,
              camp.arrival_location,
              camp.arrival_notes,
            ]
              .filter(Boolean)
              .join(' · ')}
            {camp.arrival_bring ? ` — bring: ${camp.arrival_bring}` : ''}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-5 p-4">
        {camp.days.length === 0 ? (
          <p className="text-sm text-neutral-500">No sessions scheduled.</p>
        ) : (
          camp.days.map((day) => (
            <div key={day.id}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {day.label || (day.day_number ? `Day ${day.day_number}` : 'Day')}
                {day.date ? ` · ${fmtDate(day.date)}` : ''}
              </p>
              {day.entries.length === 0 ? (
                <p className="text-[11px] text-neutral-400">No sessions</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {day.entries.map((e, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 rounded-md border border-neutral-200 bg-white px-3 py-2 shadow-sm"
                      style={e.session_colour ? { borderLeft: `3px solid ${e.session_colour}` } : undefined}
                    >
                      <div className="w-24 shrink-0 text-xs font-medium tabular-nums text-neutral-700">
                        {fmtTime(e.start_time)}
                        {e.end_time ? `–${fmtTime(e.end_time)}` : ''}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-neutral-900">
                          {e.title ?? e.subject ?? 'Session'}
                          {e.is_field_trip ? (
                            <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                              Field trip
                            </span>
                          ) : null}
                        </div>
                        {(e.tutor || e.location || e.room_number || e.session_type) && (
                          <div className="text-xs text-neutral-500">
                            {[
                              e.tutor,
                              e.location,
                              e.room_number ? `Room ${e.room_number}` : null,
                              e.session_type,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                        {e.what_to_bring ? (
                          <div className="text-[11px] text-neutral-400">Bring: {e.what_to_bring}</div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
