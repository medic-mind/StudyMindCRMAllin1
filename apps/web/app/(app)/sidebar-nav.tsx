// Client-side sidebar nav. Renders top-level items received from the
// server (already filtered by role) with Lucide-style icons and grouped
// section labels so the surface reads as designed, not as a bullet list.
// CLAUDE.md §26 (client leaves), §20 (UI hides what the user cannot do;
// server enforces too).

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType, SVGProps } from 'react'

import {
  BarChartIcon,
  BuildingIcon,
  CoinsIcon,
  GitBranchIcon,
  HomeIcon,
  InboxIcon,
  ListTodoIcon,
  SettingsIcon,
  UserCircleIcon,
  UsersIcon,
} from '@/components/ui/icon'

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

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>

const ICONS: Record<string, IconComp> = {
  '/': HomeIcon,
  '/inbox': InboxIcon,
  '/contacts': UsersIcon,
  '/accounts': BuildingIcon,
  '/pipeline': GitBranchIcon,
  '/boards': GitBranchIcon,
  '/tasks': ListTodoIcon,
  '/finance': CoinsIcon,
  '/reports': BarChartIcon,
  '/settings': SettingsIcon,
  '/account': UserCircleIcon,
}

// Section assignments. Anything not listed defaults to "Work" so the nav
// still renders cleanly if a new top-level page is added. Account pages live
// in the user menu (top right) — not here.
const SECTION: Record<string, string> = {
  '/': 'Work',
  '/inbox': 'Work',
  '/contacts': 'Work',
  '/accounts': 'Work',
  '/boards': 'Work',
  '/tasks': 'Work',
  '/finance': 'Operations',
  '/reports': 'Operations',
  '/settings': 'Admin',
}
const SECTION_ORDER = ['Work', 'Operations', 'Admin'] as const

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

export function SidebarNav({ items }: Props) {
  const pathname = usePathname() ?? ''

  // Bucket items into sections; preserve incoming order within each bucket.
  const buckets = new Map<string, NavItem[]>()
  for (const it of items) {
    const section = SECTION[it.href] ?? 'Workspace'
    const list = buckets.get(section) ?? []
    list.push(it)
    buckets.set(section, list)
  }

  return (
    <nav className="flex flex-col gap-5 text-sm" aria-label="Primary">
      {SECTION_ORDER.map((section) => {
        const group = buckets.get(section)
        if (!group || group.length === 0) return null
        return (
          <div key={section} className="flex flex-col gap-0.5">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
              {section}
            </div>
            {group.map((item) => {
              const active = isActive(pathname, item.href)
              const Icon = ICONS[item.href]
              return (
                <div key={item.href} className="flex flex-col">
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={
                      active
                        ? 'flex items-center gap-2.5 rounded-lg bg-primary-50 px-3 py-2 font-medium text-primary-800 shadow-sm ring-1 ring-primary-100'
                        : 'flex items-center gap-2.5 rounded-lg px-3 py-2 text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                    }
                  >
                    {Icon ? (
                      <Icon
                        size={16}
                        className={active ? 'text-primary-700' : 'text-neutral-400'}
                      />
                    ) : null}
                    <span>{item.label}</span>
                  </Link>
                  {active && item.children && item.children.length > 0 ? (
                    <div className="mb-1 ml-7 mt-1 flex flex-col gap-0.5 border-l border-primary-100 pl-3">
                      {item.children.map((child) => {
                        const childActive = pathname === child.href
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            aria-current={childActive ? 'page' : undefined}
                            className={
                              childActive
                                ? 'rounded-md px-2 py-1 text-xs font-medium text-primary-800'
                                : 'rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
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
          </div>
        )
      })}
    </nav>
  )
}
