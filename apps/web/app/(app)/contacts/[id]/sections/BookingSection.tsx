// Booking & hours section on the contact page. Surfaces the
// booking.studymind.co.uk mirror (ADR 0029): registration status, the hours
// balance (booked / used / remaining + expiry), credits, guardian, and the
// lessons that have taken place. Read-only; populates once the booking API
// token is set. CLAUDE.md §15, §26 (RSC presentational).

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { formatMoneyMinor } from '@/lib/format/money'

interface Lesson {
  id: string
  subject: string | null
  tutorName: string | null
  startsAt: Date | string
  endsAt: Date | string | null
  durationMinutes: number
  status: string
  payment: string | null
  isTrial: boolean
}

interface Profile {
  hoursAdded: number | null
  hoursUsed: number | null
  hoursRemaining: number | null
  premiumHoursRemaining: number | null
  nextHoursExpiryAt: Date | string | null
  creditsOnlineMmi: number
  creditsInPersonMmi: number
  creditsLiveDay: number
  creditsInPersonLiveDay: number
  hasGuardian: boolean | null
  guardianName: string | null
  guardianEmail: string | null
  guardianPhoneE164: string | null
  registeredAt: Date | string | null
  lastSyncedAt: Date | string | null
}

interface Summary {
  bookingStatus: string
  registeredOnBookingSite: boolean
  hoursBooked: number | null
  hoursDelivered: number | null
  lastLessonAt: Date | string | null
  amountSpentMinor: number | null
  profile: Profile | null
}

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  lead: { label: 'Not registered', tone: 'neutral' },
  registered_no_hours: { label: 'Registered · no hours', tone: 'info' },
  registered_with_hours: { label: 'Registered · has hours', tone: 'success' },
}

const LESSON_STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  completed: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  delivered: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  cancelled: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  no_show: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
}

function fmtDate(d: Date | string | null | undefined, withTime = false): string {
  if (!d) return '—'
  return new Intl.DateTimeFormat(
    'en-GB',
    withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
  ).format(new Date(d))
}

function hoursLabel(h: number | null | undefined): string {
  return h != null ? `${h}h` : '—'
}

export function BookingSection({ summary, lessons }: { summary: Summary; lessons: Lesson[] }) {
  const s = STATUS[summary.bookingStatus] ?? {
    label: summary.bookingStatus,
    tone: 'neutral' as BadgeTone,
  }
  const p = summary.profile
  const hoursRemaining = p?.hoursRemaining
  const credits = p
    ? p.creditsOnlineMmi + p.creditsInPersonMmi + p.creditsLiveDay + p.creditsInPersonLiveDay
    : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.tone}>{s.label}</Badge>
        {summary.registeredOnBookingSite ? (
          <span className="text-xs text-neutral-500">on booking.studymind.co.uk</span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Booked" value={hoursLabel(summary.hoursBooked ?? p?.hoursAdded ?? null)} />
        <Stat label="Used" value={hoursLabel(summary.hoursDelivered ?? p?.hoursUsed ?? null)} />
        <Stat
          label="Remaining"
          value={hoursLabel(hoursRemaining)}
          tone={hoursRemaining != null && hoursRemaining > 0 ? 'good' : 'default'}
        />
        <Stat
          label="Spent"
          value={summary.amountSpentMinor != null ? formatMoneyMinor(summary.amountSpentMinor) : '—'}
        />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-600">
        {p?.premiumHoursRemaining != null && p.premiumHoursRemaining > 0 ? (
          <span>
            Premium hours:{' '}
            <span className="font-medium text-neutral-800">{p.premiumHoursRemaining}h</span>
          </span>
        ) : null}
        {p?.nextHoursExpiryAt ? (
          <span>
            Hours expire{' '}
            <span className="font-medium text-neutral-800">{fmtDate(p.nextHoursExpiryAt)}</span>
          </span>
        ) : null}
        {credits > 0 ? (
          <span>
            Credits: <span className="font-medium text-neutral-800">{credits}</span>
          </span>
        ) : null}
        {summary.lastLessonAt ? (
          <span>
            Last lesson{' '}
            <span className="font-medium text-neutral-800">{fmtDate(summary.lastLessonAt)}</span>
          </span>
        ) : null}
        {p?.lastSyncedAt ? (
          <span className="text-neutral-400">Synced {fmtDate(p.lastSyncedAt, true)}</span>
        ) : null}
      </div>

      {p?.hasGuardian && (p.guardianName || p.guardianEmail) ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs">
          <span className="font-medium text-neutral-700">Guardian / bill-payer: </span>
          {p.guardianName ?? '—'}
          {p.guardianEmail ? ` · ${p.guardianEmail}` : ''}
          {p.guardianPhoneE164 ? ` · ${p.guardianPhoneE164}` : ''}
        </div>
      ) : null}

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Lessons
        </p>
        {lessons.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-200 px-3 py-3 text-xs text-neutral-500">
            No lessons recorded yet. Lessons appear here once the booking site is connected
            (ADR 0029).
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200">
            {lessons.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
              >
                <span className="min-w-0">
                  <span className="font-medium text-neutral-800">{l.subject ?? 'Lesson'}</span>
                  {l.isTrial ? (
                    <span className="ml-1.5 rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-800">
                      TRIAL
                    </span>
                  ) : null}
                  <span className="block text-neutral-500">
                    {fmtDate(l.startsAt, true)}
                    {l.tutorName ? ` · ${l.tutorName}` : ''}
                    {l.durationMinutes ? ` · ${l.durationMinutes}m` : ''}
                    {l.payment ? ` · ${l.payment}` : ''}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    LESSON_STATUS_TONE[l.status] ??
                    'bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200'
                  }`}
                >
                  {l.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'good'
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p
        className={`font-mono text-sm tabular-nums ${tone === 'good' ? 'text-emerald-700' : 'text-neutral-800'}`}
      >
        {value}
      </p>
    </div>
  )
}
