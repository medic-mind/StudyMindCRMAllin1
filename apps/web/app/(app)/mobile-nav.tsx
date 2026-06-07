// Mobile navigation: a hamburger trigger + slide-in drawer that reuses the
// SAME SidebarNav renderer as the desktop sidebar (one source of truth). The
// desktop <aside> is hidden below `lg`; this takes over there. The trigger is
// handed to <TopBar> as its `leading` slot so it sits at the far left of the
// bar. Accessibility mirrors the Modal primitive: portal, body-scroll lock,
// Esc to close, backdrop click to close (CLAUDE.md §28). Closes itself on
// navigation so a tap-through never leaves the drawer hanging open.

'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { XIcon } from '@/components/ui/icon'

import { BrandLogo } from '@/components/shell/brand-logo'
import { SidebarNav, type NavItem } from './sidebar-nav'

export function MobileNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Close on route change (tapping any nav link navigates → drawer closes).
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Lock body scroll + Esc-to-close while open.
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        className="-ml-1 inline-flex size-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 lg:hidden"
      >
        <MenuGlyph />
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-50 lg:hidden">
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setOpen(false)}
                className="absolute inset-0 bg-neutral-900/40 motion-safe:animate-in motion-safe:fade-in"
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Navigation"
                className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[82%] flex-col overflow-y-auto border-r border-neutral-200 bg-white px-3 py-4 shadow-xl motion-safe:animate-in motion-safe:fade-in"
              >
                <div className="mb-4 flex items-center justify-between px-1">
                  <span className="flex items-center gap-2">
                    <BrandLogo size={22} markOnly />
                    <span className="text-sm font-semibold text-primary-700">
                      StudyMind <span className="font-medium text-neutral-400">CRM</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close navigation menu"
                    className="rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                  >
                    <XIcon size={18} />
                  </button>
                </div>
                <SidebarNav items={items} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function MenuGlyph() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}
