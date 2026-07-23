// Reusable phone-number input: a searchable country dial-code picker (flag +
// name + "+code") next to a national-number field, producing an E.164 string
// (the CRM's stored format — CLAUDE.md §29). Controlled like CountrySelect:
// `value` is the E.164 string, `onChange` emits the new E.164 string.
//
// The country picker is a dependency-free combobox (not a native <select>):
// ops feedback (2026-07) was that scrolling ~200 countries to find a non-UK
// code is painful, so you can now TYPE to filter — a code ("3", "+44") narrows
// to matching dialling codes, a name ("france") narrows by country. Follows the
// same combobox pattern as suggest-input.tsx (mousedown-to-pick beats blur,
// arrow keys move the highlight, Escape closes WITHOUT closing an enclosing
// modal).
//
// Dependency-free. The data + parse/compose/filter helpers live in ./phone
// (pure, unit-tested); this file is just the React control.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/cn'
import { ChevronDownIcon, SearchIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'

import {
  composePhone,
  filterPhoneCountries,
  orderedPhoneCountries,
  parsePhone,
  PHONE_COUNTRIES,
  PINNED_DIAL_ISOS,
} from './phone'

interface Props {
  id?: string
  /** Current E.164 value (e.g. "+447700900123"). */
  value: string
  /** Called with the new E.164 value (or "" when cleared). */
  onChange: (e164: string) => void
  disabled?: boolean
  className?: string
}

export function PhoneInput({ id, value, onChange, disabled, className }: Props) {
  const [iso, setIso] = useState(() => parsePhone(value).iso)
  const [national, setNational] = useState(() => parsePhone(value).national)
  // Track the last E.164 we emitted so an external value change (form reset,
  // programmatic set) re-parses, but our own keystrokes don't fight the prop.
  const lastEmitted = useRef<string>(composePhone(iso, national))

  useEffect(() => {
    if ((value ?? '') !== lastEmitted.current) {
      const p = parsePhone(value)
      setIso(p.iso)
      setNational(p.national)
      lastEmitted.current = value ?? ''
    }
  }, [value])

  function emit(nextIso: string, nextNational: string) {
    const e164 = composePhone(nextIso, nextNational)
    lastEmitted.current = e164
    onChange(e164)
  }

  const selected = PHONE_COUNTRIES.find((c) => c.code === iso) ?? null
  const composed = composePhone(iso, national)

  return (
    <div className={className}>
      <div className="flex gap-2">
        <CountryDialPicker
          iso={iso}
          disabled={disabled}
          onSelect={(next) => {
            setIso(next)
            emit(next, national)
          }}
        />
        <Input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={national}
          disabled={disabled}
          onChange={(e) => {
            setNational(e.target.value)
            emit(iso, e.target.value)
          }}
          placeholder="Phone number"
        />
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        {composed ? (
          <>
            Saved as <span className="font-mono">{composed}</span>
          </>
        ) : (
          'Enter a number'
        )}
        {selected ? (
          <>
            {' · '}
            {selected.flag} {selected.name}
          </>
        ) : null}
      </p>
    </div>
  )
}

const TRIGGER_CLS =
  'flex h-9 w-32 shrink-0 items-center gap-1 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 shadow-[inset_0_1px_0_rgba(0,0,0,0.02)] transition-colors hover:border-neutral-400 focus-visible:outline-none focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/30 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500'

/** Searchable country dial-code combobox. */
function CountryDialPicker({
  iso,
  onSelect,
  disabled,
}: {
  iso: string
  onSelect: (iso: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = PHONE_COUNTRIES.find((c) => c.code === iso) ?? null
  const searching = query.trim().length > 0
  const results = useMemo(
    () => (searching ? filterPhoneCountries(query) : orderedPhoneCountries()),
    [query, searching],
  )
  // Index of the last pinned country in the default (unsearched) list — used to
  // draw a hairline separating "common" from the rest.
  const pinnedDividerIdx = searching ? -1 : PINNED_DIAL_ISOS.length - 1

  // Outside-click + Escape close the panel. Escape is swallowed so an enclosing
  // modal (Add-card / contact form) doesn't also close.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Focus the search box when the panel opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlight(0)
      // Defer so the input exists in the DOM.
      const t = setTimeout(() => searchRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
    return undefined
  }, [open])

  // Keep the highlighted row in view as arrow keys move it.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  function choose(next: string) {
    onSelect(next)
    setOpen(false)
    setQuery('')
    setHighlight(0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (results.length === 0 ? 0 : (h + 1) % results.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (results.length === 0 ? 0 : h <= 0 ? results.length - 1 : h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = results[highlight]
      if (pick) choose(pick.code)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Country dialling code"
        onClick={() => setOpen((v) => !v)}
        className={TRIGGER_CLS}
      >
        <span className="truncate">
          {selected ? `${selected.flag} +${selected.dial}` : 'Select'}
        </span>
        <ChevronDownIcon size={14} className="ml-auto shrink-0 text-neutral-400" />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-md border border-neutral-200 bg-white shadow-lg">
          <div className="border-b border-neutral-100 p-1.5">
            <div className="relative">
              <SearchIcon
                size={14}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400"
              />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setHighlight(0)
                }}
                onKeyDown={onKeyDown}
                placeholder="Search code or country (e.g. 3, +44, France)"
                aria-label="Search countries"
                autoComplete="off"
                className="h-8 pl-7"
              />
            </div>
          </div>
          <ul ref={listRef} role="listbox" className="max-h-60 overflow-auto py-1">
            {results.length === 0 ? (
              <li className="px-3 py-2 text-xs text-neutral-500">No matching countries</li>
            ) : (
              results.map((c, i) => (
                <li
                  key={c.code}
                  role="option"
                  aria-selected={c.code === iso}
                  data-idx={i}
                  className={
                    i === pinnedDividerIdx ? 'border-b border-neutral-200 pb-1' : undefined
                  }
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    // Pick on mousedown so the search input's blur can't race the click.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(c.code)
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                      i === highlight ? 'bg-primary-50 text-primary-800' : 'text-neutral-800 hover:bg-neutral-50',
                      c.code === iso && i !== highlight ? 'font-medium text-primary-700' : '',
                    )}
                  >
                    <span aria-hidden>{c.flag}</span>
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-neutral-500">
                      +{c.dial}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
