// "Explore the workspace" jump-to grid for the dashboard. The CRM has grown a
// lot of surfaces; this gives a returning user a fast map of where things live
// from the home page (the sidebar mirrors it). Role-aware: finance-only
// surfaces are hidden from roles that can't see them (CLAUDE.md §20). RSC.

import Link from 'next/link'
import type { ComponentType, SVGProps } from 'react'

import {
  BarChartIcon,
  BuildingIcon,
  CalendarIcon,
  CoinsIcon,
  FileTextIcon,
  GitBranchIcon,
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
]

export function QuickLinks({ role }: { role: UserRole }) {
  const links = LINKS.filter((l) => !l.financeOnly || FINANCE_ROLES.has(role))
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {links.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="group flex items-center gap-2.5 rounded-xl border border-neutral-200 bg-white px-3 py-2.5 text-sm font-medium text-neutral-700 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-200 hover:text-neutral-900 hover:shadow-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 transition-colors group-hover:bg-primary-50 group-hover:text-primary-600">
            <Icon size={15} />
          </span>
          <span className="truncate">{label}</span>
        </Link>
      ))}
    </div>
  )
}
