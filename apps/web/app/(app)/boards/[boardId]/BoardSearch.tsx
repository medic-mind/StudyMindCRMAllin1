// Board search box — a small controlled input that filters the cards already
// loaded on the board, so staff find a card by typing instead of Ctrl+F (ops
// request, 2026-07). Shared by the kanban (BoardDnd) and the list view. The
// filtering itself is the pure `filterCardsByQuery` (card-search.ts); this is
// just the field + a live result count. Esc / the clear button reset it.

'use client'

import { useEffect, useRef } from 'react'

import { SearchIcon, XIcon } from '@/components/ui/icon'

interface Props {
  value: string
  onChange: (value: string) => void
  /** Cards shown after filtering. */
  matchCount: number
  /** Total cards on the board. */
  totalCount: number
}

export function BoardSearch({ value, onChange, matchCount, totalCount }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Ctrl/⌘+F focuses the board search instead of the browser's find bar (which
  // can't see off-screen columns). Native find still works if they press it
  // again while the box is already focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        if (document.activeElement !== inputRef.current) {
          e.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const active = value.trim().length > 0

  return (
    <div className="mb-3 flex items-center gap-3">
      <div className="relative w-full max-w-sm">
        <SearchIcon
          size={15}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
        />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && active) {
              e.preventDefault()
              onChange('')
            }
          }}
          placeholder="Search cards — name, email, phone, subject, label…"
          aria-label="Search cards on this board"
          className="h-9 w-full rounded-md border border-neutral-300 bg-white pl-8 pr-8 text-sm text-neutral-900 shadow-[inset_0_1px_0_rgba(0,0,0,0.02)] transition-colors placeholder:text-neutral-400 hover:border-neutral-400 focus-visible:border-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30 [&::-webkit-search-cancel-button]:hidden"
        />
        {active ? (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          >
            <XIcon size={14} />
          </button>
        ) : null}
      </div>
      {active ? (
        <span className="shrink-0 text-xs tabular-nums text-neutral-500" aria-live="polite">
          {matchCount === 0
            ? 'No cards match'
            : `${matchCount} of ${totalCount} card${totalCount === 1 ? '' : 's'}`}
        </span>
      ) : null}
    </div>
  )
}
