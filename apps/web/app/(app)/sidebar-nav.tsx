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
  AlertTriangleIcon,
  BarChartIcon,
  BuildingIcon,
  CalendarIcon,
  GitBranchIcon,
  HashIcon,
  HomeIcon,
  InboxIcon,
  MailIcon,
  FileTextIcon,
  PhoneIcon,
  RepeatIcon,
  SettingsIcon,
  UserCircleIcon,
  UserPlusIcon,
  UsersIcon,
} from '@/components/ui/icon'

import { EXTERNAL_APP_LINKS } from '@/components/shell/external-links'

export interface NavChild {
  href: string
  label: string
}

export interface NavItem {
  href: string
  label: string
  children?: NavChild[]
  /** Optional count pill (e.g. active complaints). Hidden when 0/undefined. */
  badge?: number
}

interface Props {
  items: NavItem[]
}

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>

const ICONS: Record<string, IconComp> = {
  '/': HomeIcon,
  // Communications — customer channels.
  '/inbox': InboxIcon,
  '/mail': MailIcon,
  '/calls': PhoneIcon,
  '/call-summaries': FileTextIcon,
  // Slack — its own category (customer mentions spotted in Slack).
  '/inbox/slack-mentions': HashIcon,
  // Internal — staff↔staff (distinct glyph from the customer Trengo inbox).
  // Work.
  '/leads': UserPlusIcon,
  '/contacts': UsersIcon,
  '/accounts': BuildingIcon,
  '/pipeline': GitBranchIcon,
  '/boards': GitBranchIcon,
  '/complaints': AlertTriangleIcon,
  '/camps': CalendarIcon,
  '/webinars': CalendarIcon,
  '/direct-debits': RepeatIcon,
  '/reports': BarChartIcon,
  '/settings': SettingsIcon,
  '/account': UserCircleIcon,
}

// Section assignments. Customer comms and internal chat are deliberately
// split into separate groups so it is always obvious what is a customer
// channel vs staff↔staff. Anything not listed defaults to "Work". Account
// pages live in the user menu (top right) — not here.
const SECTION: Record<string, string> = {
  '/': 'Overview',
  // Communications — everything that talks to customers.
  '/inbox': 'Communications',
  '/mail': 'Communications',
  '/calls': 'Communications',
  '/call-summaries': 'Communications',
  // Slack — its own category per ops request (June 2026).
  '/inbox/slack-mentions': 'Slack',
  // Internal — staff↔staff only.
  // Work — CRM records.
  '/leads': 'Work',
  '/contacts': 'Work',
  '/accounts': 'Work',
  '/boards': 'Work',
  '/complaints': 'Work',
  '/camps': 'Operations',
  '/webinars': 'Operations',
  '/direct-debits': 'Operations',
  '/reports': 'Operations',
  '/settings': 'Admin',
}
const SECTION_ORDER = [
  'Overview',
  'Communications',
  'Slack',
  'Internal',
  'Work',
  'Operations',
  'Admin',
] as const

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

export function SidebarNav({ items }: Props) {
  const pathname = usePathname() ?? ''

  // Longest matching prefix wins, so nested top-level items (e.g. Slack
  // mentions at /inbox/slack-mentions vs Trengo at /inbox) never both light
  // up for the same page.
  const activeHref = items.reduce<string | null>((best, it) => {
    if (!isActive(pathname, it.href)) return best
    return !best || it.href.length > best.length ? it.href : best
  }, null)

  // Bucket items into sections; preserve incoming order within each bucket.
  // An item with no SECTION entry MUST still render — default it to a real,
  // rendered group ('Work'), never an unlisted bucket. (A previous default of
  // 'Workspace' wasn't in SECTION_ORDER, so unmapped items like /complaints
  // silently vanished from the nav.)
  const buckets = new Map<string, NavItem[]>()
  for (const it of items) {
    const section = SECTION[it.href] ?? 'Work'
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
              const active = item.href === activeHref
              const Icon = ICONS[item.href]
              return (
                <div key={item.href} className="flex flex-col">
                  {/* Active state: a clean filled primary pill — reads
                      unambiguously as "you are here" without a coloured glow.
                      Inactive rows stay quiet until hover. */}
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={
                      active
                        ? 'flex items-center gap-2.5 rounded-lg bg-primary-600 px-3 py-2 font-medium text-white shadow-sm'
                        : 'flex items-center gap-2.5 rounded-lg px-3 py-2 text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900'
                    }
                  >
                    {Icon ? (
                      <Icon
                        size={16}
                        className={active ? 'text-white' : 'text-neutral-400'}
                      />
                    ) : null}
                    <span>{item.label}</span>
                    {item.badge && item.badge > 0 ? (
                      <span
                        className={
                          active
                            ? 'ml-auto rounded-full bg-white/25 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white'
                            : 'ml-auto rounded-full bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-rose-700'
                        }
                        aria-label={`${item.badge} active`}
                      >
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    ) : null}
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

      {/* External links live in the TOP BAR from md up; this group only
          renders in the mobile drawer (below md) so phones don't lose them. */}
      <div className="flex flex-col gap-px md:hidden">
        <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-400">
          External
        </div>
        {EXTERNAL_APP_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          >
            <ExternalLinkGlyph />
            <span>{link.title}</span>
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
