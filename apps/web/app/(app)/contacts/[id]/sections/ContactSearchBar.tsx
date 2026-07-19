// Cross-channel search bar. Submits a query to contact.channels.search and
// renders the top hits with a channel chip + snippet. Client island.

'use client'

import { useState } from 'react'

import { Card } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
}

const CHANNEL_LABEL: Record<string, string> = {
  email: 'Email',
  call: 'Call',
  slack: 'Slack',
  trengo: 'Trengo',
  note: 'Note',
}

export function ContactSearchBar({ contactId }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const search = trpc.contact.channels.search.useQuery(
    { contactId, q },
    { enabled: q.trim().length >= 2 },
  )

  return (
    <div>
      <div className="relative">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this contact's emails, calls, Slack, messages, notes…"
          aria-label="Search contact channels"
          className="w-full rounded-md border border-neutral-300 bg-white py-2 pl-9 pr-3 text-sm shadow-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200"
        />
      </div>
      {q.trim().length >= 2 && (
        <Card className="mt-2 overflow-hidden">
          {search.isLoading && (
            <p className="px-3 py-2 text-sm text-neutral-500">Searching…</p>
          )}
          {search.data && search.data.length === 0 && (
            <p className="px-3 py-2 text-sm text-neutral-500">
              No matches across any channel.
            </p>
          )}
          <ol>
            {search.data?.map((hit) => (
              <li
                key={hit.id}
                className="flex items-start gap-2 border-b border-neutral-100 px-3 py-2 text-sm last:border-b-0"
              >
                <span className="mt-0.5 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase text-neutral-600">
                  {CHANNEL_LABEL[hit.channel] ?? hit.channel}
                </span>
                <span className="flex-1 text-neutral-800">{hit.snippet}</span>
                <time
                  className="text-xs text-neutral-400"
                  dateTime={new Date(hit.occurredAt).toISOString()}
                >
                  {new Intl.DateTimeFormat('en-GB', { dateStyle: 'short' }).format(
                    new Date(hit.occurredAt),
                  )}
                </time>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  )
}
