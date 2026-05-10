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
      // Negative -mx-6 -mt-6 + mb-6 lets the header sit flush against the
      // shell when the page lives inside the layout's default padded
      // content container. Pages that want a fully custom layout can wrap
      // PageHeader in a Fragment + their own padded body.
      className="-mx-6 -mt-6 mb-6 flex flex-col justify-center border-b border-neutral-200 bg-white px-6"
      style={{ minHeight: '80px' }}
    >
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="pt-2">
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
                      className="text-neutral-500 hover:text-neutral-800 hover:underline"
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

      <div className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-neutral-900">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-0.5 truncate text-sm text-neutral-600">{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  )
}
