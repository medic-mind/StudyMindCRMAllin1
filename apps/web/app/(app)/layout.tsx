import Link from 'next/link'

import { getCurrentUser, legacyAuth as auth } from '@/lib/auth/server'
import { GmailReconnectBanner } from '@/components/shell/gmail-reconnect-banner'
import { TrengoTokenBanner } from '@/components/shell/trengo-token-banner'

import { SidebarNav, type NavItem } from './sidebar-nav'
import { SignOutButton } from './sign-out-button'

// Authenticated CRM shell is always rendered per-request — never prerender.
// Without this, Next attempts to statically generate child pages at build
// time and the auth stub would throw `AUTH_PIVOT_PENDING` during static
// generation. Real auth gating returns in chunk 5 of ADR 0010.
export const dynamic = 'force-dynamic'
export const revalidate = 0

type Role =
  | 'super_admin'
  | 'admin'
  | 'ops_manager'
  | 'agent'
  | 'finance'
  | 'dsl'
  | 'read_only'

interface NavItemDef extends NavItem {
  /**
   * Roles allowed to see this nav item. `null` (or absent) means visible to
   * any authenticated user. Server-side gating is enforced inside each tRPC
   * procedure or page; sidebar visibility is just to keep the UI honest.
   */
  visibleTo?: ReadonlyArray<Role>
}

function buildNav(role: Role, totpEnabled: boolean): NavItem[] {
  const items: NavItemDef[] = [
    { href: '/inbox', label: 'Inbox' },
    { href: '/contacts', label: 'Contacts' },
    { href: '/pipeline', label: 'Pipeline' },
    { href: '/tasks', label: 'Tasks' },
    {
      href: '/finance',
      label: 'Finance',
      visibleTo: ['admin', 'super_admin', 'ops_manager', 'finance', 'agent'],
      children: [
        { href: '/finance', label: 'Discrepancies' },
        { href: '/finance/refunds', label: 'Refunds' },
        { href: '/finance/payment-links', label: 'Payment links' },
      ],
    },
    {
      href: '/safeguarding',
      label: 'Safeguarding',
      visibleTo: ['dsl', 'super_admin', 'admin'],
    },
    {
      href: '/reports',
      label: 'Reports',
      children: [
        { href: '/reports/finance', label: 'Finance' },
        { href: '/reports/operations', label: 'Operations' },
        { href: '/reports/retention', label: 'Retention' },
        { href: '/reports/cost', label: 'Cost' },
      ],
    },
    {
      href: '/settings',
      label: 'Settings',
      visibleTo: ['admin', 'super_admin', 'ops_manager'],
      children: [
        { href: '/settings/users', label: 'Users' },
        { href: '/settings/flags', label: 'Flags' },
        { href: '/settings/integrations', label: 'Integrations' },
        { href: '/settings/mailbox', label: 'Mailbox' },
      ],
    },
    {
      href: '/account',
      label: 'Account',
      children: [
        { href: '/account', label: 'Profile' },
        { href: '/account/change-password', label: 'Change password' },
        { href: '/account/sessions', label: 'Sessions' },
        {
          href: totpEnabled ? '/account/disable-2fa' : '/account/setup-2fa',
          label: totpEnabled ? 'Disable 2FA' : 'Set up 2FA',
        },
        { href: '/account/trengo/connect', label: 'Trengo' },
      ],
    },
  ]

  return items
    .filter((it) => !it.visibleTo || it.visibleTo.includes(role))
    .map((it) => ({ href: it.href, label: it.label, children: it.children }))
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Stub: real session check returns in chunk 5 of ADR 0010.
  const { userId } = await auth()
  void userId
  const me = await getCurrentUser()
  const role: Role = (me?.role as Role | undefined) ?? 'agent'
  const totpEnabled = !!me?.totpEnabledAt
  const nav = buildNav(role, totpEnabled)

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r border-neutral-200 bg-white p-4">
        <Link
          href="/"
          className="mb-6 text-sm font-semibold text-neutral-900 hover:underline"
        >
          StudyMind CRM
        </Link>
        <SidebarNav items={nav} />
        <div className="mt-auto flex flex-col gap-1 border-t border-neutral-200 pt-4 text-sm">
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1">
        <GmailReconnectBanner />
        <TrengoTokenBanner />
        <div className="p-6">{children}</div>
      </main>
    </div>
  )
}
