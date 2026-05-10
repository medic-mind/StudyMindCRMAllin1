// Centre top-bar search trigger. Opens the command palette on click, on
// Cmd/Ctrl+K, or on `/` when not focused in another input. Click renders
// the same dialog at the same z-index. CLAUDE.md §28 (keyboard reachable,
// visible focus, never strips outline).

'use client'

import { useEffect, useState } from 'react'

import { SearchIcon } from '@/components/ui/icon'

import { CommandPalette } from './command-palette'

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

export function SearchTrigger() {
  const [open, setOpen] = useState(false)
  const [mac, setMac] = useState(false)

  useEffect(() => setMac(isMac()), [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open global search"
        className="inline-flex h-9 w-full max-w-md items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-500 hover:border-neutral-300 hover:bg-white"
      >
        <SearchIcon size={16} className="text-neutral-400" />
        <span className="flex-1 text-left">Search contacts and families…</span>
        <kbd className="hidden rounded border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 sm:inline-block">
          {mac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  )
}
