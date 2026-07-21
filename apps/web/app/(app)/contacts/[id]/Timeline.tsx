// Contact Activity timeline. Revamped (user feedback: "clunky, duplicates,
// can't see full history, calls mislabelled"):
//   - every row gets an honest, human label (a real Aircall call reads
//     "Inbound call · 2m 10s"; a board quick-action note is a note/card event,
//     never a call) with a colour-coded type chip;
//   - runs of consecutive identical rows (the ×7 "Call completed." spam from
//     repeated quick-action clicks) collapse into one row with a ×N badge —
//     display-only, nothing is deleted (CLAUDE.md §3);
//   - outbound sends show their true state (sending / failed / sent) with the
//     provider's actual error, so a stuck message is visible at a glance;
//   - filter chips (All / Calls / Messages / Emails / Notes / Cards / Other)
//     cut the noise when hunting for one kind of event.
// Pure display logic lives in @/lib/timeline (unit-tested).

'use client'

import { useMemo, useState } from 'react'

import type { InteractionListItem } from '@studymind/core/interaction'

import { EmailReplyPanel } from '@/components/contact/EmailReplyPanel'
import { Button } from '@/components/ui/button'
import { displayMessageBody } from '@/lib/format/html-text'
import {
  collapseTimeline,
  TIMELINE_FILTERS,
  timelineBucket,
  timelineLabel,
  type TimelineBucket,
} from '@/lib/timeline'

import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
  initialItems: InteractionListItem[]
  initialNextCursor: { id: string; occurredAt: Date } | null
}

// A summary line for the feed. Trengo email messages store raw HTML sliced
// mid-tag as their summary; render that as readable text and cap it. Ordinary
// summaries (subjects, notes, "Card moved") are plain text — left untouched.
function renderTimelineSummary(summary: string): string {
  const text = displayMessageBody(summary) ?? summary
  return text !== summary ? text.slice(0, 400) : summary
}

const TONE_CLS: Record<ReturnType<typeof timelineLabel>['tone'], string> = {
  call: 'bg-sky-50 text-sky-800 ring-sky-200',
  message: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  email: 'bg-indigo-50 text-indigo-800 ring-indigo-200',
  note: 'bg-amber-50 text-amber-800 ring-amber-200',
  card: 'bg-violet-50 text-violet-800 ring-violet-200',
  system: 'bg-neutral-100 text-neutral-600 ring-neutral-200',
}

const STATUS_CLS: Record<string, string> = {
  sending: 'bg-amber-50 text-amber-800 ring-amber-200',
  failed: 'bg-red-50 text-red-800 ring-red-200',
  sent: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
}

export function Timeline({ contactId, initialItems, initialNextCursor }: Props) {
  const [items, setItems] = useState<InteractionListItem[]>(initialItems)
  const [cursor, setCursor] = useState<{ id: string; occurredAt: Date } | null>(initialNextCursor)
  const [filter, setFilter] = useState<TimelineBucket | 'all'>('all')
  const utils = trpc.useUtils()
  const [loading, setLoading] = useState(false)

  async function loadMore() {
    if (!cursor) return
    setLoading(true)
    try {
      const next = await utils.interaction.list.fetch({ contactId, limit: 50, cursor })
      setItems((prev) => [...prev, ...next.items])
      setCursor(next.nextCursor)
    } finally {
      setLoading(false)
    }
  }

  const entries = useMemo(() => {
    const filtered =
      filter === 'all' ? items : items.filter((it) => timelineBucket(it.type) === filter)
    return collapseTimeline(filtered)
  }, [items, filter])

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-600">
        No interactions yet — add a note above to start the timeline.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {TIMELINE_FILTERS.map((f) => {
          const active = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className={
                active
                  ? 'rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white'
                  : 'rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50'
              }
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-4 text-sm text-neutral-600">
          Nothing in this category on the loaded history — try “Load more” or another
          filter.
        </div>
      ) : (
        <ol className="space-y-2">
          {entries.map(({ item: it, count }) => {
            const { label, tone } = timelineLabel(it)
            const status = it.meta?.status ?? null
            return (
              <li key={it.id} className="rounded-md border border-neutral-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONE_CLS[tone]}`}
                    >
                      {label}
                    </span>
                    {count > 1 ? (
                      <span
                        className="inline-flex items-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-600"
                        title={`${count} identical entries collapsed`}
                      >
                        ×{count}
                      </span>
                    ) : null}
                    {status && STATUS_CLS[status] ? (
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${STATUS_CLS[status]}`}
                      >
                        {status}
                      </span>
                    ) : null}
                  </span>
                  <time dateTime={new Date(it.occurredAt).toISOString()}>
                    {new Date(it.occurredAt).toLocaleString('en-GB', { timeZone: 'Europe/London', 
                      dateStyle: 'medium',
                      timeStyle: 'short',})}
                  </time>
                </div>
                {it.summary ? (
                  <div className="mt-1.5 whitespace-pre-wrap text-sm text-neutral-900">
                    {renderTimelineSummary(it.summary)}
                  </div>
                ) : null}
                {it.meta?.error ? (
                  <p className="mt-1 text-xs text-red-700">
                    Last send error: {it.meta.error}
                  </p>
                ) : null}
                {it.type === 'email_received' && (
                  <div className="mt-2">
                    <EmailReplyPanel interactionId={it.id} />
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {cursor && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load more history'}
          </Button>
        </div>
      )}
    </div>
  )
}
