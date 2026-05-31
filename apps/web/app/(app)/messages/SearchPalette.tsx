// Message search palette (ADR 0022 — Cmd-K). Debounced full-text search over
// the viewer's visible channels, grouped result rows with channel + author +
// snippet, keyboard-navigable. Picking a result jumps to that channel (and
// opens the thread when the hit is a reply). Mirrors the global command
// palette's interaction model (§28 keyboard-first).

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { HashIcon, LockIcon, SearchIcon } from '@/components/ui/icon'
import { Avatar } from '@/components/ui/avatar'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

import type { SearchHit } from './types'

interface Props {
  open: boolean
  onClose: () => void
  /** Jump to a result: open its channel (and thread root when it's a reply). */
  onPick: (hit: SearchHit) => void
}

export function SearchPalette({ open, onClose, onPick }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [raw, setRaw] = useState('')
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)

  useEffect(() => {
    const id = setTimeout(() => setQuery(raw.trim()), 200)
    return () => clearTimeout(id)
  }, [raw])

  useEffect(() => {
    if (open) {
      setRaw('')
      setQuery('')
      setHighlight(0)
      const id = requestAnimationFrame(() => inputRef.current?.focus())
      return () => cancelAnimationFrame(id)
    }
    return undefined
  }, [open])

  const enabled = open && query.length >= 2
  const { data, isFetching } = trpc.chat.search.useQuery(
    { q: query },
    { enabled, staleTime: 15_000 },
  )

  const hits = useMemo(() => data?.hits ?? [], [data])
  useEffect(() => setHighlight(0), [query])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(hits.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      const pick = hits[highlight]
      if (pick) {
        e.preventDefault()
        onPick(pick)
      }
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search messages"
      className="fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/40 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl ring-1 ring-black/5">
        <div className="flex items-center gap-2.5 border-b border-neutral-100 px-3.5 py-2.5">
          <SearchIcon size={16} className="shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search messages…"
            className="w-full bg-transparent py-1 text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
            aria-label="Search messages"
            autoComplete="off"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {query.length < 2 ? (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">
              Type at least 2 characters. ↑↓ to navigate, Enter to open, Esc to close.
            </p>
          ) : enabled && isFetching && hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">Searching…</p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">
              No messages match &ldquo;{query}&rdquo;.
            </p>
          ) : (
            hits.map((hit, i) => (
              <button
                key={hit.messageId}
                type="button"
                onClick={() => onPick(hit)}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-start gap-3 px-4 py-2.5 text-left ${
                  highlight === i ? 'bg-neutral-100' : 'hover:bg-neutral-50'
                }`}
              >
                <Avatar name={hit.authorName} size={30} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                    {hit.channelKind === 'private' ? (
                      <LockIcon size={11} />
                    ) : hit.channelKind === 'dm' ? null : (
                      <HashIcon size={11} />
                    )}
                    <span className="font-medium text-neutral-700">{hit.channelTitle}</span>
                    <span>·</span>
                    <span>{hit.authorName}</span>
                    <span>·</span>
                    <span>{formatRelativeTime(hit.occurredAt)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-neutral-800">
                    {hit.snippet}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="border-t border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[10px] text-neutral-500">
          ↑↓ navigate · Enter open · Esc close
        </div>
      </div>
    </div>
  )
}
