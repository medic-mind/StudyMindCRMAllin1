// Call history table (client island). URL-driven filters (window / direction /
// outcome / recordings) so views are shareable; recordings expand inline via the
// shared RecordingPlayer. CLAUDE.md §26 (client leaves), §10.

'use client'

import Link from 'next/link'
import { useState } from 'react'

import { RecordingPlayer } from '@/components/shared/recording-player'

type Direction = 'all' | 'inbound' | 'outbound'
type Outcome = 'all' | 'answered' | 'missed' | 'voicemail'

interface Item {
  callKey: string
  occurredAt: Date | string
  direction: 'inbound' | 'outbound' | null
  durationSec: number
  outcome: 'answered' | 'missed' | 'voicemail'
  phone: string | null
  contactId: string | null
  contactName: string | null
  contactKind: string | null
  recordingInteractionId: string | null
}

interface Counts {
  total: number
  inbound: number
  outbound: number
  answered: number
  missed: number
  voicemail: number
}

interface Props {
  items: Item[]
  counts: Counts
  direction: Direction
  outcome: Outcome
  days: number
  withRecording: boolean
  page: number
  pageSize: number
  total: number
  capped: boolean
}

const OUTCOME_STYLE: Record<Item['outcome'], string> = {
  answered: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  voicemail: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  missed: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
}

const WINDOWS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
]

const DIRECTIONS: ReadonlyArray<{ key: Direction; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'inbound', label: 'Inbound' },
  { key: 'outbound', label: 'Outbound' },
]

const OUTCOMES: ReadonlyArray<{ key: Outcome; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'answered', label: 'Answered' },
  { key: 'missed', label: 'Missed' },
  { key: 'voicemail', label: 'Voicemail' },
]

function fmtDuration(sec: number): string {
  if (!sec) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

function fmtWhen(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(d),
  )
}

export function CallHistoryTable({
  items,
  counts,
  direction,
  outcome,
  days,
  withRecording,
  page,
  pageSize,
  total,
  capped,
}: Props): JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Build a URL preserving the current filters, with overrides. Any filter
  // change resets to page 1.
  const href = (overrides: Partial<{ days: number; direction: Direction; outcome: Outcome; rec: boolean; page: number }>) => {
    const q: Record<string, string> = {}
    const d = overrides.days ?? days
    const dir = overrides.direction ?? direction
    const out = overrides.outcome ?? outcome
    const rec = overrides.rec ?? withRecording
    const pg = overrides.page ?? 1
    if (d !== 90) q.days = String(d)
    if (dir !== 'all') q.direction = dir
    if (out !== 'all') q.outcome = out
    if (rec) q.rec = '1'
    if (pg !== 1) q.page = String(pg)
    return { pathname: '/calls/history', query: q }
  }

  const chip = (active: boolean) =>
    active
      ? 'inline-flex items-center rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white shadow-sm'
      : 'inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900'

  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1
  const showingTo = Math.min(total, page * pageSize)

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <FilterRow label="Window">
            {WINDOWS.map((w) => (
              <Link key={w.days} href={href({ days: w.days })} className={chip(days === w.days)}>
                {w.label}
              </Link>
            ))}
          </FilterRow>
          <FilterRow label="Direction">
            {DIRECTIONS.map((d) => (
              <Link key={d.key} href={href({ direction: d.key })} className={chip(direction === d.key)}>
                {d.label}
              </Link>
            ))}
          </FilterRow>
          <FilterRow label="Outcome">
            {OUTCOMES.map((o) => (
              <Link key={o.key} href={href({ outcome: o.key })} className={chip(outcome === o.key)}>
                {o.label}
              </Link>
            ))}
          </FilterRow>
          <Link href={href({ rec: !withRecording })} className={chip(withRecording)}>
            Has recording
          </Link>
        </div>
        <p className="text-xs text-neutral-500">
          {counts.total} call{counts.total === 1 ? '' : 's'} · {counts.inbound} in · {counts.outbound}{' '}
          out · {counts.answered} answered · {counts.missed} missed · {counts.voicemail} voicemail
          {capped ? ' · showing the most recent 20,000' : ''}
        </p>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 text-left text-[11px] uppercase tracking-wide text-neutral-500">
              <th className="px-4 py-2.5 font-semibold">Direction</th>
              <th className="px-4 py-2.5 font-semibold">Contact / number</th>
              <th className="px-4 py-2.5 font-semibold">Outcome</th>
              <th className="px-4 py-2.5 font-semibold text-right">Duration</th>
              <th className="px-4 py-2.5 font-semibold text-right">When</th>
              <th className="px-4 py-2.5 font-semibold text-right">Recording</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-neutral-500">
                  No calls match these filters in this window.
                </td>
              </tr>
            ) : (
              items.map((c) => {
                const isOpen = c.recordingInteractionId ? open.has(c.callKey) : false
                return (
                  <tr key={c.callKey} className="align-top">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium ${
                          c.direction === 'outbound' ? 'text-sky-700' : 'text-neutral-700'
                        }`}
                      >
                        {c.direction === 'inbound' ? '↘ In' : c.direction === 'outbound' ? '↗ Out' : '— Call'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {c.contactId ? (
                        <Link
                          href={`/contacts/${c.contactId}`}
                          className="font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                        >
                          {c.contactName ?? 'Contact'}
                        </Link>
                      ) : (
                        <span className="text-neutral-500">Unknown</span>
                      )}
                      {c.phone ? (
                        <span className="mt-0.5 block font-mono text-xs text-neutral-500">{c.phone}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${OUTCOME_STYLE[c.outcome]}`}
                      >
                        {c.outcome}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-neutral-600">
                      {fmtDuration(c.durationSec)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-neutral-500">
                      <time dateTime={new Date(c.occurredAt).toISOString()}>{fmtWhen(c.occurredAt)}</time>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {c.recordingInteractionId ? (
                        <button
                          type="button"
                          onClick={() => toggle(c.callKey)}
                          aria-expanded={isOpen}
                          className="rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-primary-700 hover:bg-neutral-50"
                        >
                          {isOpen ? 'Hide' : '▸ Play'}
                        </button>
                      ) : (
                        <span className="text-xs text-neutral-300">—</span>
                      )}
                      {isOpen && c.recordingInteractionId ? (
                        <div className="mt-2 text-left">
                          <RecordingPlayer src={`/api/internal/audio/${c.recordingInteractionId}`} />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > pageSize ? (
        <div className="flex items-center justify-between text-xs text-neutral-600">
          <span>
            Showing {showingFrom}–{showingTo} of {total}
          </span>
          <span className="flex items-center gap-2">
            {page > 1 ? (
              <Link href={href({ page: page - 1 })} className={chip(false)}>
                ← Previous
              </Link>
            ) : (
              <span className="inline-flex items-center rounded-full border border-neutral-100 px-3 py-1 text-neutral-300">
                ← Previous
              </span>
            )}
            <span className="tabular-nums">
              Page {page} / {lastPage}
            </span>
            {page < lastPage ? (
              <Link href={href({ page: page + 1 })} className={chip(false)}>
                Next →
              </Link>
            ) : (
              <span className="inline-flex items-center rounded-full border border-neutral-100 px-3 py-1 text-neutral-300">
                Next →
              </span>
            )}
          </span>
        </div>
      ) : null}
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      {children}
    </div>
  )
}
