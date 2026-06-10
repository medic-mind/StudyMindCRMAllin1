// In-app suggestion input (combobox): a styled text field whose suggestion
// panel is rendered BY the app, not the browser — replaces native <datalist>,
// whose dropdown is browser chrome we can't style and that looks foreign next
// to the design system. Dependency-free like Popover (no Radix in the tree);
// follows the WAI-ARIA combobox pattern: arrow keys move the highlight, Enter
// picks (without submitting the surrounding form), Escape closes, outside
// click closes. Free text is always allowed — the options are suggestions,
// not constraints. CLAUDE.md §28.

'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/cn'

import { Input } from './input'

interface Props {
  id?: string
  value: string
  onChange: (value: string) => void
  /** Suggestion list. Filtered case-insensitively as the user types. */
  options: ReadonlyArray<string>
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

export function SuggestInput({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  'aria-label': ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q) return options.slice(0, 12)
    // Typed-prefix matches first, then substring matches.
    const starts: string[] = []
    const contains: string[] = []
    for (const o of options) {
      const lo = o.toLowerCase()
      if (lo === q) continue // exactly what's typed — nothing to suggest
      if (lo.startsWith(q)) starts.push(o)
      else if (lo.includes(q)) contains.push(o)
    }
    return [...starts, ...contains].slice(0, 12)
  }, [options, value])

  // Outside click closes (mirrors the Popover primitive).
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Keep the highlight in range as the filter narrows.
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(filtered.length - 1)
  }, [filtered.length, highlight])

  function pick(option: string) {
    onChange(option)
    setOpen(false)
    setHighlight(-1)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight((h) => (filtered.length === 0 ? -1 : (h + 1) % filtered.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight((h) =>
        filtered.length === 0 ? -1 : h <= 0 ? filtered.length - 1 : h - 1,
      )
    } else if (e.key === 'Enter') {
      // Only intercept Enter when an option is actively highlighted —
      // otherwise let the form submit as normal with the typed text.
      if (open && highlight >= 0 && highlight < filtered.length) {
        e.preventDefault()
        pick(filtered[highlight]!)
      }
    } else if (e.key === 'Escape') {
      if (open) {
        // Swallow it so an enclosing modal doesn't also close.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        setHighlight(-1)
      }
    }
  }

  const showPanel = open && !disabled && filtered.length > 0

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <Input
        id={id}
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showPanel && highlight >= 0 ? `${listId}-opt-${highlight}` : undefined
        }
        aria-label={ariaLabel}
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setHighlight(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showPanel ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {filtered.map((o, i) => (
            <li key={o} id={`${listId}-opt-${i}`} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                tabIndex={-1}
                // Pick on mousedown so the input's blur can't race the click.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(o)
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  'block w-full px-3 py-1.5 text-left text-sm text-neutral-800',
                  i === highlight ? 'bg-primary-50 text-primary-800' : 'hover:bg-neutral-50',
                )}
              >
                {o}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
