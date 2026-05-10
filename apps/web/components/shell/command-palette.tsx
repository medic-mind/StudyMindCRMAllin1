// Global Cmd+K search palette. Calls search.global over tRPC with debounce,
// renders grouped results (Contacts, Families), and lets the user jump to
// the picked entity's detail page. CLAUDE.md §26 (RSC + client island),
// §28 (keyboard-first), §44.2 (no PII in URLs).

'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

import { trpc } from '@/lib/trpc/client'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [raw, setRaw] = useState('')
  const [query, setQuery] = useState('')

  // Debounce input by 200 ms so we don't fire a tRPC call per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQuery(raw.trim()), 200)
    return () => clearTimeout(id)
  }, [raw])

  useEffect(() => {
    if (open) {
      setRaw('')
      setQuery('')
      // Defer the focus so the dialog is mounted before we steal focus.
      const id = requestAnimationFrame(() => inputRef.current?.focus())
      return () => cancelAnimationFrame(id)
    }
    return undefined
  }, [open])

  const enabled = open && query.length >= 2
  const { data, isFetching } = trpc.search.global.useQuery(
    { q: query },
    { enabled, staleTime: 30_000 },
  )

  const flat = useMemo(() => {
    type Row = { kind: string; id: string; label: string; sub?: string; href: string }
    if (!data) return [] as Row[]
    const rows: Row[] = []
    for (const c of data.contacts ?? []) {
      const sub = [c.email, c.phoneE164].filter(Boolean).join(' · ')
      rows.push({
        kind: 'Contact',
        id: c.id,
        label: c.displayName,
        sub: sub.length > 0 ? sub : undefined,
        href: `/contacts/${c.id}`,
      })
    }
    for (const f of data.families ?? []) {
      rows.push({
        kind: 'Family',
        id: f.id,
        label: f.name,
        sub: f.billingContactName ?? undefined,
        href: `/contacts/families/${f.id}`,
      })
    }
    return rows
  }, [data])

  const [highlight, setHighlight] = useState(0)
  useEffect(() => {
    setHighlight(0)
  }, [query])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onOpenChange(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(flat.length - 1, 0)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      const pick = flat[highlight]
      if (pick) {
        e.preventDefault()
        onOpenChange(false)
        router.push(pick.href)
      }
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false)
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg">
        <div className="border-b border-neutral-200 p-2">
          <input
            ref={inputRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search contacts and families…"
            className="w-full bg-transparent px-2 py-2 text-sm outline-none placeholder:text-neutral-400"
            aria-label="Search query"
            autoComplete="off"
          />
        </div>
        <div className="max-h-80 overflow-y-auto py-2">
          {query.length < 2 && (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">
              Start typing to search. ↑↓ to navigate, Enter to open, Esc to close.
            </p>
          )}
          {enabled && isFetching && flat.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">Searching…</p>
          )}
          {enabled && !isFetching && flat.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-neutral-500">
              No matches for &ldquo;{query}&rdquo;.
            </p>
          )}
          {flat.map((row, i) => (
            <button
              key={`${row.kind}:${row.id}`}
              type="button"
              onClick={() => {
                onOpenChange(false)
                router.push(row.href)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm focus:outline-none ${
                highlight === i ? 'bg-neutral-100' : 'hover:bg-neutral-50'
              }`}
            >
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600">
                {row.kind}
              </span>
              <span className="flex-1 truncate">
                <span className="font-medium text-neutral-900">{row.label}</span>
                {row.sub && (
                  <span className="ml-2 text-xs text-neutral-500">{row.sub}</span>
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[10px] text-neutral-500">
          ↑↓ navigate · Enter open · Esc close
        </div>
      </div>
    </div>
  )
}
