// Cross-channel search bar. Submits a query to contact.channels.search and
// renders the top hits with a channel chip + snippet. Client island.

'use client'

import { useState } from 'react'

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
    <div className="mt-4">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search this contact's emails, calls, Slack, messages, notes…"
        aria-label="Search contact channels"
        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm"
      />
      {q.trim().length >= 2 && (
        <div className="mt-2 rounded-md border border-neutral-200 bg-white">
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
        </div>
      )}
    </div>
  )
}
