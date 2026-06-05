// URL-driven tab strip for dense detail pages (customers, B2B accounts) so a
// long stack of sections becomes navigable instead of one endless scroll. The
// active tab lives in the URL (?tab=…) so it's shareable and survives refresh,
// and only the active tab's content is mounted — client sections in other tabs
// don't fetch until opened. Keyboard-accessible (CLAUDE.md §28).
//
// Compound API:
//   <DetailTabs>
//     <TabPanel id="overview" label="Overview">…</TabPanel>
//     <TabPanel id="comms" label="Comms" count={3}>…</TabPanel>
//   </DetailTabs>

'use client'

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export interface TabPanelProps {
  id: string
  label: string
  count?: number | null
  children: ReactNode
}

/** Marker component — DetailTabs reads its props; its body never renders. */
export function TabPanel(_props: TabPanelProps): null {
  return null
}

export function DetailTabs({
  children,
  paramKey = 'tab',
}: {
  children: ReactNode
  paramKey?: string
}) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const panels = Children.toArray(children).filter(
    (c): c is ReactElement<TabPanelProps> => isValidElement(c) && c.type === TabPanel,
  )
  if (panels.length === 0) return null

  const requested = searchParams.get(paramKey)
  const current = panels.find((p) => p.props.id === requested) ?? panels[0]!

  function select(id: string) {
    const params = new URLSearchParams(Array.from(searchParams.entries()))
    params.set(paramKey, id)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Sections"
        className="sticky top-0 z-10 -mx-1 flex flex-wrap gap-1 border-b border-neutral-200 bg-neutral-50/90 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-neutral-50/70"
      >
        {panels.map((p) => {
          const on = p.props.id === current.props.id
          return (
            <button
              key={p.props.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => select(p.props.id)}
              className={
                on
                  ? 'inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-primary-700 shadow-card ring-1 ring-inset ring-neutral-200'
                  : 'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-white/70 hover:text-neutral-900'
              }
            >
              {p.props.label}
              {p.props.count != null && p.props.count > 0 ? (
                <span
                  className={
                    on
                      ? 'rounded-full bg-primary-100 px-1.5 text-[10px] font-semibold text-primary-800'
                      : 'rounded-full bg-neutral-200 px-1.5 text-[10px] font-semibold text-neutral-600'
                  }
                >
                  {p.props.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" className="space-y-5">
        {current.props.children}
      </div>
    </div>
  )
}
