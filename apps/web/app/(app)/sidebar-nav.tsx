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
  MailIcon,
  MessageSquareIcon,
  SettingsIcon,
  UserCircleIcon,
  UsersIcon,
} from '@/components/ui/icon'

/**
 * External links shown at the bottom of the sidebar — quick jumps to the
 * sister-app surfaces. Open in a new tab. Configurable via env so a
 * self-hosted install can re-point them without a code change.
 */
const EXTERNAL_LINKS = [
  {
    label: 'Main Portal',
    href:
      process.env['NEXT_PUBLIC_MAIN_PORTAL_URL'] ?? 'https://portal.studymind.co.uk',
  },
  {
    label: 'Invoice Site',
    href:
      process.env['NEXT_PUBLIC_INVOICE_SITE_URL'] ?? 'https://b2b.studymind.co.uk',
  },
]

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
  '/mail': MailIcon,
  '/messages': MessageSquareIcon,
  '/leads': InboxIcon,
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
  '/mail': 'Work',
  '/messages': 'Work',
  '/leads': 'Work',
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
    <nav className="flex flex-col gap-6 text-sm" aria-label="Primary">
      {SECTION_ORDER.map((section) => {
        const group = buckets.get(section)
        if (!group || group.length === 0) return null
        return (
          <div key={section} className="flex flex-col gap-px">
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
              {section}
            </div>
            {group.map((item) => {
              const active = isActive(pathname, item.href)
              const Icon = ICONS[item.href]
              return (
                <div key={item.href} className="flex flex-col">
                  {/* Active state uses a small left accent bar + tinted bg
                      instead of the previous ring+shadow combo, which read as
                      "selected button" rather than "active nav row". The bar
                      anchors the eye and is consistent with the section
                      divider below. */}
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={
                      active
                        ? 'relative flex items-center gap-2.5 rounded-md bg-primary-50 px-3 py-2 font-medium text-primary-800 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r before:bg-primary-600'
                        : 'flex items-center gap-2.5 rounded-md px-3 py-2 text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
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
                    <div className="mb-2 ml-7 mt-1 flex flex-col gap-px border-l border-primary-100 pl-3">
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
                                : 'rounded px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
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

      <div className="flex flex-col gap-px">
        <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          External
        </div>
        {EXTERNAL_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            <ExternalLinkGlyph />
            <span>{link.label}</span>
          </a>
        ))}
      </div>
    </nav>
  )
}

function ExternalLinkGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-neutral-400"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}
