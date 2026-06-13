// "Explore the workspace" jump-to grid for the dashboard. The CRM has grown a
// lot of surfaces; this gives a returning user a fast map of where things live
// from the home page (the sidebar mirrors it). Role-aware: finance-only
// surfaces are hidden from roles that can't see them (CLAUDE.md §20). RSC.

import Link from 'next/link'
import type { ComponentType, SVGProps } from 'react'

import {
  BarChartIcon,
  BookOpenIcon,
  BuildingIcon,
  CalendarIcon,
  CoinsIcon,
  FileTextIcon,
  GitBranchIcon,
  HashIcon,
  InboxIcon,
  ListTodoIcon,
  MailIcon,
  PhoneIcon,
  RepeatIcon,
  UserPlusIcon,
  UsersIcon,
} from '@/components/ui/icon'
import type { UserRole } from '@/lib/trpc/builders'

type IconComp = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>

const FINANCE_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager', 'manager'])

interface QuickLink {
  href: string
  label: string
  icon: IconComp
  financeOnly?: boolean
}

const LINKS: readonly QuickLink[] = [
  { href: '/inbox', label: 'Trengo', icon: InboxIcon },
  { href: '/mail', label: 'Mail', icon: MailIcon },
  { href: '/calls', label: 'Calls', icon: PhoneIcon },
  { href: '/call-summaries', label: 'Call summaries', icon: FileTextIcon },
  { href: '/messages', label: 'Team chat', icon: HashIcon },
  { href: '/leads', label: 'Leads', icon: UserPlusIcon },
  { href: '/contacts', label: 'Customers', icon: UsersIcon },
  { href: '/accounts', label: 'B2B / Schools', icon: BuildingIcon },
  { href: '/boards', label: 'Boards', icon: GitBranchIcon },
  { href: '/tasks', label: 'Tasks', icon: ListTodoIcon },
  { href: '/camps', label: 'Summer Camps', icon: CalendarIcon },
  { href: '/webinars', label: 'Webinars', icon: CalendarIcon },
  { href: '/finance', label: 'Finance', icon: CoinsIcon, financeOnly: true },
  { href: '/direct-debits', label: 'Direct Debits', icon: RepeatIcon, financeOnly: true },
  { href: '/reports', label: 'Reports', icon: BarChartIcon },
  { href: '/protocols', label: 'Protocols', icon: BookOpenIcon },
]

export function QuickLinks({ role }: { role: UserRole }) {
  const links = LINKS.filter((l) => !l.financeOnly || FINANCE_ROLES.has(role))
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {links.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 shadow-card transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <Icon size={16} className="shrink-0 text-neutral-400" />
          <span className="truncate">{label}</span>
        </Link>
      ))}
    </div>
  )
}
