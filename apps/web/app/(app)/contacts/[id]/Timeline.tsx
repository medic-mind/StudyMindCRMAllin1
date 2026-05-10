'use client'

import { useState } from 'react'

import type { InteractionListItem } from '@studymind/core/interaction'

import { EmailReplyPanel } from '@/components/contact/EmailReplyPanel'
import { Button } from '@/components/ui/button'

import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
  initialItems: InteractionListItem[]
  initialNextCursor: { id: string; occurredAt: Date } | null
}

export function Timeline({ contactId, initialItems, initialNextCursor }: Props) {
  const [items, setItems] = useState<InteractionListItem[]>(initialItems)
  const [cursor, setCursor] = useState<{ id: string; occurredAt: Date } | null>(initialNextCursor)
  const utils = trpc.useUtils()
  const [loading, setLoading] = useState(false)

  async function loadMore() {
    if (!cursor) return
    setLoading(true)
    try {
      const next = await utils.interaction.list.fetch({ contactId, limit: 25, cursor })
      setItems((prev) => [...prev, ...next.items])
      setCursor(next.nextCursor)
    } finally {
      setLoading(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-300 p-6 text-sm text-neutral-600">
        No interactions yet — add a note above to start the timeline.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {items.map((it) => (
          <li key={it.id} className="rounded-md border border-neutral-200 bg-white p-3">
            <div className="flex items-center justify-between text-xs text-neutral-500">
              <span className="font-mono">{it.type}</span>
              <time dateTime={it.occurredAt.toString()}>
                {new Date(it.occurredAt).toLocaleString('en-GB', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </time>
            </div>
            <div className="mt-1.5 text-sm text-neutral-900">{it.summary ?? '—'}</div>
            {it.type === 'email_sent' /* received maps to email_sent in mapDbType */ ? null : null}
            {it.type === 'email_received' && (
              <div className="mt-2">
                <EmailReplyPanel interactionId={it.id} />
              </div>
            )}
          </li>
        ))}
      </ol>
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
