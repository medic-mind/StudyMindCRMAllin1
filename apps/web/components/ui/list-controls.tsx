// Shared list-control primitives — the consistent Sort menu, page-size
// selector, and pagination/count bar used by every dense list in the CRM
// (Contacts, Accounts, …). Like FacetedFilter/SearchField, state lives in the
// URL (CLAUDE.md §26) so a filtered+sorted+paged view stays shareable.
//
// SortMenu + PageSizeSelect drop pagination cursors on change so you never
// land on an empty page mid-paginate.

'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { cn } from '@/lib/cn'

import { ChevronDownIcon } from './icon'
import { Popover } from './popover'

const DEFAULT_RESET_KEYS = ['cursorId', 'cursorAt', 'cursor', 'page'] as const

export interface SortOption {
  value: string
  label: string
  /** Direction applied when this field is first picked. Defaults to 'desc'
   * (most/newest first); name-like fields usually want 'asc'. */
  defaultDir?: 'asc' | 'desc'
}

/**
 * URL-driven sort control. Writes `sortBy` + `sortDir`. Picking the active
 * field flips the direction; picking a new field applies its default
 * direction. Pairs with server-side ordering, but also works for a list that
 * sorts client-side off the same two params.
 */
export function SortMenu({
  options,
  paramKey = 'sortBy',
  dirKey = 'sortDir',
  defaultValue,
  align = 'end',
}: {
  options: ReadonlyArray<SortOption>
  paramKey?: string
  dirKey?: string
  /** Field treated as active when the URL has no sortBy. */
  defaultValue: string
  align?: 'start' | 'end'
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const activeValue = searchParams.get(paramKey) ?? defaultValue
  const activeDir = searchParams.get(dirKey) === 'asc' ? 'asc' : 'desc'
  const activeOption = options.find((o) => o.value === activeValue) ?? options[0]

  function apply(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    let dir: 'asc' | 'desc'
    if (value === activeValue) {
      dir = activeDir === 'asc' ? 'desc' : 'asc'
    } else {
      dir = options.find((o) => o.value === value)?.defaultDir ?? 'desc'
    }
    params.set(paramKey, value)
    params.set(dirKey, dir)
    for (const key of DEFAULT_RESET_KEYS) params.delete(key)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <Popover
      align={align}
      triggerClassName={cn(
        'inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-700 transition-colors',
        'hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1',
      )}
      trigger={
        <>
          <SortGlyph dir={activeDir} />
          <span>
            Sort: <span className="text-neutral-900">{activeOption?.label}</span>
          </span>
          <ChevronDownIcon size={14} className="flex-none text-neutral-400" aria-hidden />
        </>
      }
    >
      {(close) => (
        <ul role="listbox" aria-label="Sort by" className="min-w-[12rem] space-y-0.5">
          {options.map((o) => {
            const isActive = o.value === activeValue
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    apply(o.value)
                    close()
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
                    'hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:outline-none',
                    isActive ? 'font-medium text-neutral-900' : 'text-neutral-700',
                  )}
                >
                  <span>{o.label}</span>
                  {isActive ? <SortGlyph dir={activeDir} /> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Popover>
  )
}

function SortGlyph({ dir }: { dir: 'asc' | 'desc' }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none text-primary-500"
      aria-hidden
    >
      {dir === 'desc' ? (
        <>
          <path d="M11 5h10" />
          <path d="M11 12h7" />
          <path d="M11 19h4" />
          <path d="M3 8l3 3 3-3" />
        </>
      ) : (
        <>
          <path d="M11 5h4" />
          <path d="M11 12h7" />
          <path d="M11 19h10" />
          <path d="M3 8l3-3 3 3" />
        </>
      )}
    </svg>
  )
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const

/**
 * URL-driven page-size selector. Writes `pageSize` and resets to page 1.
 */
export function PageSizeSelect({
  paramKey = 'pageSize',
  defaultValue = 25,
  options = PAGE_SIZE_OPTIONS,
}: {
  paramKey?: string
  defaultValue?: number
  options?: ReadonlyArray<number>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const current = Number(searchParams.get(paramKey)) || defaultValue

  function change(size: number) {
    const params = new URLSearchParams(searchParams.toString())
    params.set(paramKey, String(size))
    for (const key of DEFAULT_RESET_KEYS) params.delete(key)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-neutral-300 bg-white pl-3 pr-1.5 text-sm text-neutral-600">
      <span className="text-neutral-500">Show</span>
      <select
        value={current}
        onChange={(e) => change(Number(e.target.value))}
        aria-label="Rows per page"
        className="cursor-pointer rounded bg-transparent py-1 pr-5 text-sm font-medium text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * "Showing A–B of T" count + Prev/Next page navigation. URL-driven on `page`
 * (1-based). Render nothing-but-the-count when there's only one page so the
 * bar never adds dead controls.
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  shown,
  paramKey = 'page',
  className,
}: {
  /** 1-based current page. */
  page: number
  pageSize: number
  /** Total rows across all pages. */
  total: number
  /** Rows actually rendered on this page (for the count label). */
  shown: number
  paramKey?: string
  className?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), totalPages)
  const first = total === 0 ? 0 : (safePage - 1) * pageSize + 1
  const last = total === 0 ? 0 : first + shown - 1

  function go(toPage: number) {
    const params = new URLSearchParams(searchParams.toString())
    if (toPage <= 1) params.delete(paramKey)
    else params.set(paramKey, String(toPage))
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-600',
        className,
      )}
    >
      <p aria-live="polite">
        {total === 0 ? (
          'No results'
        ) : (
          <>
            Showing <span className="font-medium text-neutral-800 tabular-nums">{first}</span>–
            <span className="font-medium text-neutral-800 tabular-nums">{last}</span> of{' '}
            <span className="font-medium text-neutral-800 tabular-nums">{total}</span>
          </>
        )}
      </p>
      {totalPages > 1 && (
        <div className="flex items-center gap-1.5">
          <PageButton onClick={() => go(safePage - 1)} disabled={safePage <= 1}>
            Previous
          </PageButton>
          <span className="px-1 text-xs text-neutral-500 tabular-nums">
            Page {safePage} of {totalPages}
          </span>
          <PageButton onClick={() => go(safePage + 1)} disabled={safePage >= totalPages}>
            Next
          </PageButton>
        </div>
      )}
    </div>
  )
}

function PageButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 items-center rounded-md border border-neutral-300 bg-white px-3 text-sm font-medium text-neutral-700 transition-colors',
        'hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {children}
    </button>
  )
}
