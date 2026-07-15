// Client-side family timeline with type-filter chips. CLAUDE.md §6.2, §26.

'use client'

import { useMemo, useState } from 'react'

import type { InteractionListItem } from '@studymind/core/interaction'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  familyId: string
  initialItems: InteractionListItem[]
  initialNextCursor: { id: string; occurredAt: Date } | null
}

type FilterKey = 'all' | 'payment' | 'message' | 'call' | 'note'

const FILTERS: { key: FilterKey; label: string; matches: (t: string) => boolean }[] = [
  { key: 'all', label: 'All', matches: () => true },
  { key: 'payment', label: 'Payments', matches: (t) => t.startsWith('payment') },
  { key: 'message', label: 'Messages', matches: (t) => t.startsWith('message') || t.startsWith('email') || t.startsWith('ticket') },
  { key: 'call', label: 'Calls', matches: (t) => t.startsWith('call') },
  { key: 'note', label: 'Notes', matches: (t) => t === 'note' },
]

export function FamilyTimeline({ familyId, initialItems, initialNextCursor }: Props) {
  const [items, setItems] = useState<InteractionListItem[]>(initialItems)
  const [cursor, setCursor] = useState<{ id: string; occurredAt: Date } | null>(initialNextCursor)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [loading, setLoading] = useState(false)
  const utils = trpc.useUtils()

  const filtered = useMemo(() => {
    const matcher = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]!
    return items.filter((it) => matcher.matches(it.type as string))
  }, [items, filter])

  async function loadMore() {
    if (!cursor) return
    setLoading(true)
    try {
      const next = await utils.interaction.list.fetch({
        familyId,
        limit: 50,
        cursor,
      })
      setItems((prev) => [...prev, ...next.items])
      setCursor(next.nextCursor)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Filter timeline by type">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-full px-3 py-1 text-xs ${
              filter === f.key
                ? 'bg-neutral-900 text-white'
                : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-600">
          No interactions match this filter — try widening the selection.
        </div>
      ) : (
        <ol className="space-y-2">
          {filtered.map((it) => (
            <li key={it.id} className="rounded-md border border-neutral-200 bg-white p-3">
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span className="font-mono">{it.type}</span>
                <time dateTime={it.occurredAt.toString()}>
                  {new Date(it.occurredAt).toLocaleString('en-GB', { timeZone: 'Europe/London', 
                    dateStyle: 'medium',
                    timeStyle: 'short',})}
                </time>
              </div>
              <div className="mt-1 text-sm text-neutral-900">{it.summary ?? '—'}</div>
            </li>
          ))}
        </ol>
      )}

      {cursor && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
