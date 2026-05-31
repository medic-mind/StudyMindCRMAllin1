// Toolbar — a horizontal action bar primitive. Used today for the bulk-
// actions strip that appears above the Contacts table when rows are
// selected; ready to be reused on any list/table that grows a similar
// affordance.
//
// Visually a primary-tinted panel with a hairline ring + soft shadow so it
// reads as "active state" without competing with the table chrome below.
// Pass actions as children; the `clear` slot pins a tertiary "Clear" or
// "Cancel" control to the right.

import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

interface ToolbarProps {
  /** Lead phrase, e.g. "3 selected". Renders bold and tinted. */
  label: ReactNode
  /** Right-aligned escape hatch (Clear selection, Cancel, etc). Optional. */
  clear?: ReactNode
  /** Action buttons. Rendered left-aligned after the label. */
  children: ReactNode
  className?: string
}

export function Toolbar({ label, clear, children, className }: ToolbarProps) {
  return (
    <div
      className={cn(
        // primary-50/70 instead of /full so the toolbar reads as a "selected"
        // wash, not a solid CTA. ring-inset keeps the hairline tucked.
        'flex flex-wrap items-center gap-2 rounded-lg bg-primary-50/70 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-primary-100',
        className,
      )}
    >
      <span className="font-medium text-primary-900">{label}</span>
      <span aria-hidden className="text-primary-300">
        ·
      </span>
      {children}
      {clear ? <span className="ml-auto">{clear}</span> : null}
    </div>
  )
}
