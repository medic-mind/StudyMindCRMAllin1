// Headless popover primitive. Dependency-free (CLAUDE.md §3 — no Radix in the
// tree today) but accessible: the trigger is a real button with
// `aria-expanded`/`aria-haspopup`, the panel closes on outside-click and
// Escape, and focus returns to the trigger on close. Use it for filter
// menus, overflow menus, and lightweight pickers — anywhere a full dialog
// would be too heavy.

'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { cn } from '@/lib/cn'

interface PopoverProps {
  /** Contents of the trigger button. */
  trigger: ReactNode
  /**
   * Panel contents. When a function, it receives a `close` callback so an
   * action inside the panel (e.g. "Clear") can dismiss it.
   */
  children: ReactNode | ((close: () => void) => ReactNode)
  /** Horizontal edge the panel aligns to. Defaults to `start` (left). */
  align?: 'start' | 'end'
  /** Accessible label for the trigger when its content is icon-only. */
  ariaLabel?: string
  triggerClassName?: string
  panelClassName?: string
  /** Reflected onto the trigger so callers can mark an active/filtered state. */
  'data-active'?: boolean
}

export function Popover({
  trigger,
  children,
  align = 'start',
  ariaLabel,
  triggerClassName,
  panelClassName,
  ...rest
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  const close = useCallback(() => {
    setOpen(false)
    // Return focus to the trigger so keyboard users keep their place.
    triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        data-active={rest['data-active'] ? '' : undefined}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          className={cn(
            'absolute z-50 mt-1.5 min-w-[12rem] rounded-xl border border-neutral-200 bg-white p-1 shadow-lg shadow-neutral-900/5',
            'origin-top animate-[popover-in_120ms_ease-out]',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  )
}
