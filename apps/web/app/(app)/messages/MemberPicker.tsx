// Reusable teammate multi-picker (ADR 0022). Used by the create-channel dialog
// (initial members), the new-DM dialog, and the channel "add people" action.

'use client'

import { useState } from 'react'

import { Avatar } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import type { UserHit } from './types'

interface Props {
  selectedIds: string[]
  onChange: (ids: string[]) => void
  /** Cap the selection (e.g. DMs allow up to 8). */
  max?: number
}

export function MemberPicker({ selectedIds, onChange, max }: Props) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Record<string, UserHit>>({})

  const search = trpc.chat.userSearch.useQuery(
    { q: query },
    { staleTime: 10_000 },
  )

  function add(user: UserHit) {
    if (selectedIds.includes(user.id)) return
    if (max && selectedIds.length >= max) return
    setPicked((p) => ({ ...p, [user.id]: user }))
    onChange([...selectedIds, user.id])
    setQuery('')
  }

  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id))
  }

  const available = (search.data ?? []).filter((u) => !selectedIds.includes(u.id))

  return (
    <div>
      {selectedIds.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedIds.map((id) => {
            const u = picked[id]
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 py-0.5 pl-1 pr-2 text-xs text-primary-800"
              >
                <Avatar name={u?.name ?? '?'} size={18} />
                {u?.name ?? 'Selected'}
                <button
                  type="button"
                  aria-label={`Remove ${u?.name ?? 'member'}`}
                  onClick={() => remove(id)}
                  className="text-primary-500 hover:text-primary-800"
                >
                  <XIcon size={12} />
                </button>
              </span>
            )
          })}
        </div>
      ) : null}

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search teammates…"
        disabled={Boolean(max && selectedIds.length >= max)}
      />

      {query.length > 0 ? (
        <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-neutral-200">
          {available.length === 0 ? (
            <li className="px-3 py-2 text-xs text-neutral-500">No matches.</li>
          ) : (
            available.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => add(u)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50"
                >
                  <Avatar name={u.name} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-900">{u.name}</span>
                    <span className="block truncate text-xs text-neutral-500">{u.email}</span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
