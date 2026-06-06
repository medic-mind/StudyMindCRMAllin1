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
        className="group inline-flex h-10 w-full max-w-lg cursor-text items-center gap-2.5 rounded-xl border border-neutral-200/80 bg-neutral-100/60 px-3.5 text-sm text-neutral-500 shadow-sm shadow-neutral-200/40 transition-all hover:border-neutral-300 hover:bg-white hover:text-neutral-700 hover:shadow-md hover:shadow-neutral-200/50 focus-visible:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <SearchIcon size={16} className="text-neutral-400 transition-colors group-hover:text-primary-600" />
        <span className="flex-1 text-left">Search contacts, families, tasks…</span>
        <kbd className="hidden items-center gap-0.5 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[10px] font-medium text-neutral-500 sm:inline-flex">
          {mac ? '⌘' : 'Ctrl'}
          <span>K</span>
        </kbd>
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  )
}
