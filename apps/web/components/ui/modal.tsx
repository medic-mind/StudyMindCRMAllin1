// Accessible modal primitive (CLAUDE.md §28). Focus-traps, closes on Esc and
// overlay click, restores focus to the trigger on close, locks body scroll, and
// honours prefers-reduced-motion. Rendered through a portal so it escapes any
// transformed/stacking ancestor (e.g. board cards). This is THE modal surface —
// compose, quick-create, and confirm dialogs all build on it instead of
// hand-rolling overlays.

'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { XIcon } from './icon'

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
  xl: 'max-w-3xl',
} as const

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  size?: keyof typeof SIZES
  /** Accessible label when no visible title is rendered. */
  ariaLabel?: string
  /** Set false to keep the modal open on overlay/Esc (e.g. mid-submit). */
  dismissable?: boolean
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  ariaLabel,
  dismissable = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    // Lock body scroll while the modal is up.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Move focus into the panel.
    const id = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const first = panel.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? panel).focus()
    })

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && dismissable) {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      // Restore focus to whatever opened the modal.
      previouslyFocused.current?.focus?.()
    }
  }, [open, onClose, dismissable])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4 motion-safe:animate-in motion-safe:fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel}
        tabIndex={-1}
        className={`flex max-h-[90vh] w-full ${SIZES[size]} flex-col overflow-hidden rounded-xl bg-white shadow-card-hover outline-none`}
      >
        {title != null ? (
          <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
            >
              <XIcon size={16} />
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer != null ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-4 py-2.5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
