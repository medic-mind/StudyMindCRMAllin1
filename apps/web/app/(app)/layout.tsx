import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'
import { BackfillProgressBanner } from '@/components/shell/backfill-progress-banner'
import { GmailReconnectBanner } from '@/components/shell/gmail-reconnect-banner'
import { TopBar } from '@/components/shell/top-bar'
import { TrengoTokenBanner } from '@/components/shell/trengo-token-banner'

import { SidebarNav, type NavItem } from './sidebar-nav'

// Authenticated CRM shell is always rendered per-request — never prerender.
// Without this, Next attempts to statically generate child pages at build
// time and the auth stub would throw `AUTH_PIVOT_PENDING` during static
// generation. Real auth gating returns in chunk 5 of ADR 0010.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Canonical sales-CRM roles (ADR 0014).
type Role =
  | 'ceo'
  | 'senior_manager'
  | 'manager'
  | 'sales_executive'
  | 'virtual_assistant'

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
    { href: '/', label: 'Dashboard' },
    { href: '/inbox', label: 'Inbox' },
    { href: '/contacts', label: 'Contacts' },
    {
      href: '/boards',
      label: 'Boards',
    },
    { href: '/tasks', label: 'Tasks' },
    {
      href: '/finance',
      label: 'Finance',
      // Sales Executives do not see the Finance dashboard — they can create
      // payment links from the contact detail UI but never see refund/
      // allocation tooling. CEO, Senior Manager, Manager only (ADR 0014).
      visibleTo: ['ceo', 'senior_manager', 'manager'],
      children: [
        { href: '/finance', label: 'Discrepancies' },
        { href: '/finance/refunds', label: 'Refunds' },
        { href: '/finance/payment-links', label: 'Payment links' },
      ],
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
      // Settings is admin-tier. CEO and Senior Manager get the full panel;
      // Manager can read Integrations only (each child page enforces its own
      // role gate so Users / Flags / Mailbox stay locked to CEO/SM).
      // ADR 0014.
      visibleTo: ['ceo', 'senior_manager', 'manager'],
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
  // Defence-in-depth: middleware redirects unauthenticated requests at the
  // edge, but if for any reason it doesn't (matcher miss, edge fallback,
  // stale build), the (app) shell MUST refuse to render to an anonymous
  // visitor. Without this guard the layout was happily rendering the app
  // shell with a fallback role of 'agent'.
  const me = await getCurrentUser()
  if (!me) {
    redirect('/sign-in')
  }
  // Force mustResetPassword users to the change-password page even on direct
  // (app) navigation — middleware does this too, but this guarantees the
  // child page never renders against a half-bootstrapped account.
  if (me.mustResetPassword) {
    redirect('/account/change-password')
  }
  const role: Role = me.role
  const totpEnabled = !!me.totpEnabledAt
  const nav = buildNav(role, totpEnabled)

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <TopBar
        user={{ email: me.email, name: me.name ?? null, role: me.role }}
      />
      <div className="flex flex-1">
        <aside
          className="flex flex-col border-r border-neutral-200 bg-white px-3 py-4"
          style={{ width: 'var(--shell-sidebar-width)' }}
          aria-label="Sidebar"
        >
          <SidebarNav items={nav} />
        </aside>
        <main id="main" className="flex-1">
          <GmailReconnectBanner />
          <TrengoTokenBanner />
          <BackfillProgressBanner />
          <div className="px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  )
}
