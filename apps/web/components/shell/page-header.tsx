// PageHeader — the standard 80px header used by every (app)/* page.
// Renders a breadcrumb row (when provided) above a title row with right-
// aligned actions. CLAUDE.md §26 (RSC by default — this is a presentational
// server component with no client behaviour).

import Link from 'next/link'
import type { ReactNode } from 'react'

import { ChevronRightIcon } from '@/components/ui/icon'

export interface Crumb {
  label: string
  href: string
}

interface Props {
  title: string
  subtitle?: string
  breadcrumbs?: Crumb[]
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, breadcrumbs, actions }: Props) {
  return (
    <header
      // Flat white surface + hairline divider — replaces the previous
      // gradient that competed with content cards below for visual weight.
      // Tighter padding (no minHeight) keeps the chrome out of the way on
      // dense surfaces; subtitle still gets room when present. The negative
      // margins/padding track the shell's responsive content padding (px-4 on
      // mobile, px-6 on sm+) so the header always runs flush to the surface.
      className="-mx-4 -mt-4 mb-6 border-b border-neutral-200/80 bg-white px-4 pb-4 pt-4 sm:-mx-6 sm:-mt-6 sm:px-6"
    >
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-neutral-500">
            {breadcrumbs.map((c, idx) => {
              const last = idx === breadcrumbs.length - 1
              return (
                <li key={`${c.href}-${idx}`} className="flex items-center gap-1">
                  {last ? (
                    <span className="text-neutral-700" aria-current="page">
                      {c.label}
                    </span>
                  ) : (
                    <Link
                      href={c.href}
                      className="text-neutral-500 transition-colors hover:text-neutral-800"
                    >
                      {c.label}
                    </Link>
                  )}
                  {!last ? (
                    <ChevronRightIcon
                      size={12}
                      className="text-neutral-400"
                    />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </nav>
      ) : null}

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold leading-tight tracking-tight text-neutral-900">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1 truncate text-sm text-neutral-500">{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  )
}
