// Filter bar — the consistent container that holds a list page's search field
// and faceted filters on one row, with a "Clear all" affordance that appears
// only when something is actually filtering. Pairs with <SearchField> and
// <FacetedFilter>. CLAUDE.md §26 (filter state lives in the URL).

'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { cn } from '@/lib/cn'

import { XIcon } from './icon'

export function FilterBar({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {children}
    </div>
  )
}

/**
 * A single on/off filter (e.g. "Overdue only"). Sets `paramKey=value` when on,
 * removes it when off, and drops pagination cursors on change.
 */
export function ToggleFilter({
  paramKey,
  label,
  value = '1',
  tone = 'brand',
}: {
  paramKey: string
  label: string
  value?: string
  /** Active colour — brand by default, `danger` for things like overdue. */
  tone?: 'brand' | 'danger'
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const active = searchParams.get(paramKey) === value

  function toggle() {
    const params = new URLSearchParams(searchParams.toString())
    if (active) params.delete(paramKey)
    else params.set(paramKey, value)
    params.delete('cursorId')
    params.delete('cursorAt')
    params.delete('cursor')
    params.delete('page')
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const activeClass =
    tone === 'danger'
      ? 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
      : 'border-primary-300 bg-primary-50 text-primary-800 hover:bg-primary-100'

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1',
        active
          ? activeClass
          : 'border-dashed border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50',
      )}
    >
      {label}
    </button>
  )
}

/**
 * Clears every filter param it owns in one click. Renders nothing when none
 * of those params are set, so it never adds visual noise to an unfiltered
 * view. Pass the full set of param keys the page's filters use.
 */
export function ClearFiltersButton({
  paramKeys,
}: {
  paramKeys: ReadonlyArray<string>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const activeCount = paramKeys.filter((k) => searchParams.get(k)).length
  if (activeCount === 0) return null

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString())
    for (const key of paramKeys) params.delete(key)
    params.delete('cursorId')
    params.delete('cursorAt')
    params.delete('cursor')
    params.delete('page')
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <button
      type="button"
      onClick={clearAll}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
    >
      <XIcon size={14} />
      Clear
      {activeCount > 1 ? ` (${activeCount})` : ''}
    </button>
  )
}
