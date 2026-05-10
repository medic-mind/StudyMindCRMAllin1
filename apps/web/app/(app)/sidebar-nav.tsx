// Client-side sidebar nav. Renders the top-level items received from the
// server (already filtered by role) and shows an inline sub-nav under the
// item that matches the current route. CLAUDE.md §26 (client leaves), §20
// (UI hides what the user cannot do; server enforces too).

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export interface NavChild {
  href: string
  label: string
}

export interface NavItem {
  href: string
  label: string
  children?: NavChild[]
}

interface Props {
  items: NavItem[]
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

export function SidebarNav({ items }: Props) {
  const pathname = usePathname() ?? ''
  return (
    <nav className="flex flex-col gap-1 text-sm">
      {items.map((item) => {
        const active = isActive(pathname, item.href)
        return (
          <div key={item.href} className="flex flex-col">
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded bg-neutral-100 px-2 py-1.5 font-medium text-neutral-900'
                  : 'rounded px-2 py-1.5 text-neutral-700 hover:bg-neutral-100'
              }
            >
              {item.label}
            </Link>
            {active && item.children && item.children.length > 0 ? (
              <div className="ml-3 mt-1 flex flex-col gap-0.5 border-l border-neutral-200 pl-2">
                {item.children.map((child) => {
                  const childActive = pathname === child.href
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      aria-current={childActive ? 'page' : undefined}
                      className={
                        childActive
                          ? 'rounded px-2 py-1 text-xs font-medium text-neutral-900'
                          : 'rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100'
                      }
                    >
                      {child.label}
                    </Link>
                  )
                })}
              </div>
            ) : null}
          </div>
        )
      })}
    </nav>
  )
}
