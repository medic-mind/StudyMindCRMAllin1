// Faceted filter — the single, consistent filter control for every list in
// the CRM. Replaces the bespoke rows of pill <Link>s that each page used to
// hand-roll. State lives in the URL (CLAUDE.md §26) so views stay shareable;
// changing a filter drops pagination cursors so you never land on an empty
// page mid-paginate.
//
// Single mode: picking a value replaces the param; picking the active value
// clears it. Multiple mode: values are comma-joined.

'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { cn } from '@/lib/cn'

import { CheckIcon, PlusIcon } from './icon'
import { Popover } from './popover'

export interface FacetOption {
  value: string
  label: string
  /** Optional indicator dot colour (company colour, status tone, etc). */
  color?: string
}

interface FacetedFilterProps {
  /** URL search param this filter owns. */
  paramKey: string
  /** Trigger label shown when nothing is selected. */
  label: string
  options: ReadonlyArray<FacetOption>
  /** Allow more than one value (comma-joined in the URL). */
  multiple?: boolean
  /** Extra params to clear when the filter changes (defaults to cursors). */
  resetKeys?: ReadonlyArray<string>
  align?: 'start' | 'end'
}

const DEFAULT_RESET_KEYS = ['cursorId', 'cursorAt', 'cursor', 'page'] as const

export function FacetedFilter({
  paramKey,
  label,
  options,
  multiple = false,
  resetKeys = DEFAULT_RESET_KEYS,
  align = 'start',
}: FacetedFilterProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const raw = searchParams.get(paramKey)
  const selected = new Set(
    raw ? raw.split(',').map((v) => v.trim()).filter(Boolean) : [],
  )

  function commit(nextValues: Set<string>) {
    const params = new URLSearchParams(searchParams.toString())
    if (nextValues.size === 0) {
      params.delete(paramKey)
    } else {
      params.set(paramKey, Array.from(nextValues).join(','))
    }
    for (const key of resetKeys) params.delete(key)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  function toggle(value: string) {
    const next = new Set(selected)
    if (multiple) {
      if (next.has(value)) next.delete(value)
      else next.add(value)
    } else {
      // Single-select: re-clicking the active option clears it.
      if (next.has(value)) next.clear()
      else {
        next.clear()
        next.add(value)
      }
    }
    commit(next)
  }

  const selectedOptions = options.filter((o) => selected.has(o.value))
  const active = selectedOptions.length > 0

  return (
    <Popover
      align={align}
      data-active={active}
      triggerClassName={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1',
        active
          ? 'border-primary-300 bg-primary-50 text-primary-800 hover:bg-primary-100'
          : 'border-dashed border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50',
      )}
      trigger={
        <>
          {!active && (
            <PlusIcon size={14} className="text-neutral-400" aria-hidden />
          )}
          <span>{label}</span>
          {active && (
            <>
              <span
                aria-hidden
                className="h-3.5 w-px bg-primary-300"
              />
              {selectedOptions.length <= 2 ? (
                <span className="flex items-center gap-1">
                  {selectedOptions.map((o) => (
                    <span
                      key={o.value}
                      className="rounded bg-primary-100 px-1.5 py-0.5 text-xs font-semibold text-primary-700"
                    >
                      {o.label}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="rounded bg-primary-100 px-1.5 py-0.5 text-xs font-semibold text-primary-700">
                  {selectedOptions.length} selected
                </span>
              )}
            </>
          )}
        </>
      }
    >
      {(close) => (
        <div className="max-h-72 overflow-y-auto">
          <ul role="listbox" aria-label={label} className="space-y-0.5">
            {options.map((o) => {
              const isOn = selected.has(o.value)
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isOn}
                    onClick={() => {
                      toggle(o.value)
                      if (!multiple) close()
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm',
                      'hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none',
                      isOn ? 'font-medium text-neutral-900' : 'text-neutral-700',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 flex-none items-center justify-center rounded border',
                        isOn
                          ? 'border-primary-600 bg-primary-600 text-white'
                          : 'border-neutral-300 bg-white',
                      )}
                    >
                      {isOn && <CheckIcon size={12} />}
                    </span>
                    {o.color && (
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 flex-none rounded-full"
                        style={{ backgroundColor: o.color }}
                      />
                    )}
                    <span className="truncate">{o.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {active && (
            <div className="mt-1 border-t border-neutral-100 pt-1">
              <button
                type="button"
                onClick={() => {
                  commit(new Set())
                  close()
                }}
                className="w-full rounded-lg px-2 py-1.5 text-center text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}
