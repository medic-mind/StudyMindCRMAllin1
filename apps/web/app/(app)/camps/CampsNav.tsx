// Segmented sub-navigation for the Summer Camp section — one coherent switcher
// (camp-app style) instead of ad-hoc link rows on each page.

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/cn'

const TABS = [
  { href: '/camps', label: 'Overview', exact: true },
  { href: '/camps/bookings', label: 'Bookings' },
  { href: '/camps/timetable', label: 'Schedule' },
  { href: '/camps/purchases', label: 'Stripe purchases' },
  { href: '/camps/instalments', label: 'Instalments' },
]

export function CampsNav() {
  const pathname = usePathname()
  return (
    <nav
      aria-label="Summer Camp sections"
      className="mb-6 inline-flex flex-wrap gap-1 rounded-xl bg-neutral-100 p-1"
    >
      {TABS.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-white text-neutral-900 shadow-sm'
                : 'text-neutral-600 hover:text-neutral-900',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
