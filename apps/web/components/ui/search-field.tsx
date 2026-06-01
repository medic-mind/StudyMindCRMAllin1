// URL-driven search input. Debounced so typing doesn't hammer the server,
// with an inline clear button and a leading search glyph. Replaces the old
// "type then press a Search button" forms — results update as you type and
// the query stays in the URL so the view is shareable (CLAUDE.md §26).

'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { cn } from '@/lib/cn'

import { SearchIcon, XIcon } from './icon'

interface SearchFieldProps {
  /** URL param the query is stored under. Defaults to `q`. */
  paramKey?: string
  placeholder?: string
  /** Params to clear when the query changes (defaults to cursors). */
  resetKeys?: ReadonlyArray<string>
  className?: string
  debounceMs?: number
}

const DEFAULT_RESET_KEYS = ['cursorId', 'cursorAt', 'cursor', 'page'] as const

export function SearchField({
  paramKey = 'q',
  placeholder = 'Search…',
  resetKeys = DEFAULT_RESET_KEYS,
  className,
  debounceMs = 300,
}: SearchFieldProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlValue = searchParams.get(paramKey) ?? ''
  const [value, setValue] = useState(urlValue)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep local state in sync when the URL changes from elsewhere (e.g. a
  // "Clear all" reset), but never stomp on what the user is actively typing.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setValue(urlValue)
  }, [urlValue])

  function push(next: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (next.trim()) params.set(paramKey, next.trim())
    else params.delete(paramKey)
    for (const key of resetKeys) params.delete(key)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  useEffect(() => {
    if (value === urlValue) return
    const id = setTimeout(() => push(value), debounceMs)
    return () => clearTimeout(id)
  }, [value, debounceMs])

  return (
    <div className={cn('relative min-w-0 flex-1 sm:max-w-xs', className)}>
      <SearchIcon
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
      />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            push(value)
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          'h-9 w-full rounded-lg border border-neutral-300 bg-white pl-9 pr-9 text-sm',
          'placeholder:text-neutral-400',
          'focus-visible:border-primary-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30',
          // Hide the native search "x" so ours is the only clear affordance.
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setValue('')
            push('')
            inputRef.current?.focus()
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
        >
          <XIcon size={14} />
        </button>
      )}
    </div>
  )
}
