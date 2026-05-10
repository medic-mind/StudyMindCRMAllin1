// Client-side sidebar nav. Renders top-level items received from the
// server (already filtered by role) with Lucide-style icons (custom inline
// SVGs from @/components/ui/icon — CLAUDE.md §3 forbids new deps without
// an ADR) and an inline sub-nav for the matching route.
// CLAUDE.md §26 (client leaves), §20 (UI hides what the user cannot do;
// server enforces too).

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType, SVGProps } from 'react'

import {
  BarChartIcon,
  CoinsIcon,
  GitBranchIcon,
  HomeIcon,
  InboxIcon,
  ListTodoIcon,
  SettingsIcon,
  ShieldAlertIcon,
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
  '/pipeline': GitBranchIcon,
  '/tasks': ListTodoIcon,
  '/finance': CoinsIcon,
  '/safeguarding': ShieldAlertIcon,
  '/reports': BarChartIcon,
  '/settings': SettingsIcon,
  '/account': UserCircleIcon,
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

export function SidebarNav({ items }: Props) {
  const pathname = usePathname() ?? ''
  return (
    <nav className="flex flex-col gap-0.5 text-sm" aria-label="Primary">
      {items.map((item) => {
        const active = isActive(pathname, item.href)
        const Icon = ICONS[item.href]
        return (
          <div key={item.href} className="flex flex-col">
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'flex items-center gap-2 rounded-md border-l-2 border-primary-600 bg-primary-50 px-2 py-1.5 font-medium text-primary-800'
                  : 'flex items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-1.5 text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900'
              }
            >
              {Icon ? (
                <Icon
                  size={16}
                  className={active ? 'text-primary-700' : 'text-neutral-500'}
                />
              ) : null}
              <span>{item.label}</span>
            </Link>
            {active && item.children && item.children.length > 0 ? (
              <div className="ml-6 mt-0.5 flex flex-col gap-0.5">
                {item.children.map((child) => {
                  const childActive = pathname === child.href
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      aria-current={childActive ? 'page' : undefined}
                      className={
                        childActive
                          ? 'rounded px-2 py-1 text-xs font-medium text-primary-800'
                          : 'rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900'
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
