import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { getBrandingLogoMeta } from '@studymind/core/branding'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { createServerCaller } from '@/lib/trpc/server'
import { ComposeEmailProvider } from '@/components/mail/compose-email'
import { ConfirmProvider } from '@/components/ui/confirm'
import { BackfillProgressBanner } from '@/components/shell/backfill-progress-banner'
import { GmailReconnectBanner } from '@/components/shell/gmail-reconnect-banner'
import { NavigationProgress } from '@/components/shell/navigation-progress'
import { TopBar } from '@/components/shell/top-bar'
import { TrengoTokenBanner } from '@/components/shell/trengo-token-banner'

import { MobileNav } from './mobile-nav'
import { settingsNavChildren } from './settings/settings-links'
import { SidebarNav, type NavItem } from './sidebar-nav'

// Authenticated CRM shell is always rendered per-request — never prerender.
// Without this, Next attempts to statically generate child pages at build
// time and the auth stub would throw `AUTH_PIVOT_PENDING` during static
// generation. Real auth gating returns in chunk 5 of ADR 0010.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Canonical sales-CRM roles (ADR 0014).
type Role = 'ceo' | 'senior_manager' | 'manager' | 'sales_executive' | 'virtual_assistant'

interface NavItemDef extends NavItem {
  /**
   * Roles allowed to see this nav item. `null` (or absent) means visible to
   * any authenticated user. Server-side gating is enforced inside each tRPC
   * procedure or page; sidebar visibility is just to keep the UI honest.
   */
  visibleTo?: ReadonlyArray<Role>
}

function buildNav(role: Role): NavItem[] {
  // Day-to-day work first, then ops/analytics, then admin. Account is
  // intentionally not here — it lives in the user menu (top right) so the
  // sidebar stays focused on actual work surfaces.
  const items: NavItemDef[] = [
    { href: '/', label: 'Dashboard' },
    // Communications — customer channels. Trengo is the unified cross-channel
    // customer inbox (WhatsApp / SMS / web-chat / email, synced with Trengo);
    // Mail is the focused email client. Both are customer-facing.
    // Trengo is worked in the real Trengo app now (the embedded cockpit was
    // retired); /inbox is a gateway page with a big "Go to Trengo" button.
    { href: '/inbox', label: 'Trengo' },
    { href: '/mail', label: 'Mail' },
    // Slack — its own category: the triage tray for customer mentions the AI
    // spotted in watched Slack channels (ADR 0034).
    { href: '/inbox/slack-mentions', label: 'Slack mentions' },
    // Calls — the missed-calls queue (inbound calls to follow up; calling back
    // clears them automatically, CLAUDE.md §10) and the full Aircall call
    // history. Operational, so all call-handling staff.
    {
      href: '/calls',
      label: 'Calls',
      children: [
        { href: '/calls', label: 'Missed calls' },
        { href: '/calls/history', label: 'Call history' },
      ],
    },
    // Call Summaries — submit a summary for anyone (even someone not yet on
    // the CRM); a smart de-dup guard aligns it with an existing contact.
    { href: '/call-summaries', label: 'Call Summaries' },
    // Team chat removed from the nav at the operator's request (2026-07) —
    // /messages now redirects to the inbox; the chat backend is retained
    // (forward-only, §19) should it ever come back.
    { href: '/leads', label: 'Web Enquiries' },
    {
      href: '/contacts',
      label: 'B2C Customers',
      children: [
        { href: '/contacts', label: 'All customers' },
        { href: '/contacts/at-risk', label: 'At-risk hours' },
        { href: '/contacts/duplicates', label: 'Duplicates' },
      ],
    },
    {
      href: '/accounts',
      label: 'B2B / Schools',
      children: [
        { href: '/accounts?kind=school', label: 'Schools' },
        { href: '/accounts?kind=partnership', label: 'B2B Partners' },
      ],
    },
    { href: '/boards', label: 'Boards' },
    {
      href: '/complaints',
      label: 'Complaints',
      children: [
        { href: '/complaints', label: 'Queue' },
        // The complaints analytics report lives under Complaints now (moved
        // out of Reports, 2026-07).
        { href: '/complaints/reports', label: 'Report' },
      ],
    },
    // Read-only live view of the Summer Camp app: which camps are running, how
    // full they are, and the weekly session timetables. For the sales team.
    {
      href: '/camps',
      label: 'Summer Camps',
      children: [
        { href: '/camps', label: 'Camps running' },
        { href: '/camps/timetable', label: 'Schedule' },
      ],
    },
    {
      href: '/webinars',
      label: 'Webinars',
      children: [
        { href: '/webinars', label: 'Overview' },
        { href: '/webinars/groups', label: 'Groups' },
        { href: '/webinars/subjects', label: 'Subjects & levels' },
        { href: '/webinars/enrollments', label: 'Enrolments' },
        { href: '/webinars/settings', label: 'Settings' },
      ],
    },
    // Finance (Stripe reconciliation/refunds/payment-links) removed from the
    // nav at the operator's request (2026-07) — StudyMind no longer processes
    // payments through Stripe. The /finance/* routes are retained (forward-only,
    // §19) so any deep link still resolves; they are simply no longer surfaced
    // in the sidebar. Direct Debits (GoCardless, below) is the live money
    // surface and stays as its own top-level section.
    // GoCardless Direct Debits — its own top-level section (ADR 0038). The
    // master dashboard lives at /direct-debits; the old /finance/direct-debit
    // route redirects here so there is exactly ONE home for Direct Debits.
    {
      href: '/direct-debits',
      label: 'Direct Debits',
      visibleTo: ['ceo', 'senior_manager', 'manager'],
      children: [
        { href: '/direct-debits', label: 'Overview' },
        { href: '/direct-debits/plans', label: 'Plans' },
        { href: '/direct-debits/payments', label: 'Payments' },
        { href: '/direct-debits/customers', label: 'Customers & mandates' },
        { href: '/direct-debits/payouts', label: 'Payouts' },
        { href: '/direct-debits/activity', label: 'Activity' },
        { href: '/direct-debits/issues', label: 'Issues' },
      ],
    },
    {
      href: '/reports',
      label: 'Reports',
      children: [
        { href: '/reports/aircall', label: 'Aircall' },
        { href: '/reports/cost', label: 'Cost' },
      ],
    },
    {
      href: '/settings',
      label: 'Settings',
      // Settings is admin-tier. CEO and Senior Manager get the full panel;
      // Manager can read Integrations only (each child page enforces its own
      // role gate). The sub-nav is the SHARED settings list (settings-links.ts)
      // that also drives the Settings landing page, so the two never drift.
      visibleTo: ['ceo', 'senior_manager', 'manager'],
      children: settingsNavChildren(),
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
  // (app) navigation — middleware does this too, but this guarantees the child
  // page never renders against a half-bootstrapped account. CRITICAL: exempt
  // the change-password page itself (and sign-out), or this layout redirects it
  // to itself → ERR_TOO_MANY_REDIRECTS, which locked every new colleague (who
  // starts with a temp password → mustResetPassword) out of the CRM on first
  // login. Mirrors the middleware's exemption; pathname comes from the header
  // middleware sets.
  const pathname = (await headers()).get('x-pathname') ?? ''
  if (
    me.mustResetPassword &&
    pathname !== '/account/change-password' &&
    !pathname.startsWith('/api/auth/')
  ) {
    redirect('/account/change-password')
  }
  const role: Role = me.role
  const totpEnabled = !!me.totpEnabledAt
  const nav = buildNav(role)

  // Branding + the active-complaints badge are independent of each other and
  // of nav building — fetch them in parallel rather than serially so the shell
  // (which renders on EVERY navigation) costs one round-trip, not three. A
  // count failure must never take down the shell.
  const caller = await createServerCaller()
  // Neither the logo nor the complaints badge may take down the whole shell —
  // a transient DB hiccup on either must degrade gracefully, not blank every
  // page for the user (defence against a post-login "nothing loads" screen).
  const [branding, activeComplaints] = await Promise.all([
    getBrandingLogoMeta(db).catch(() => ({
      hasLogo: false as const,
      contentType: null,
      version: null,
    })),
    caller.complaint.activeCount().catch(() => 0),
  ])
  if (activeComplaints > 0) {
    const complaintsItem = nav.find((it) => it.href === '/complaints')
    if (complaintsItem) complaintsItem.badge = activeComplaints
  }

  return (
    // Shell-wide workflow-popup providers (CLAUDE.md §26). ConfirmProvider gives
    // every surface a branded guarded-confirm; ComposeEmailProvider wraps the
    // TopBar too so the ⌘K command palette can open the in-house composer. VAs
    // can draft but not send (role-gated).
    <ConfirmProvider>
      <ComposeEmailProvider canSend={role !== 'virtual_assistant'}>
        <div className="flex min-h-screen flex-col bg-neutral-50">
          <NavigationProgress />
          <TopBar
            user={{
              email: me.email,
              name: me.name ?? null,
              role: me.role,
              totpEnabled,
            }}
            logoVersion={branding.version}
            leading={<MobileNav items={nav} />}
          />
          <div className="flex flex-1">
            {/* Persistent sidebar on lg+; on smaller screens it collapses and
                the MobileNav drawer (in the top bar) takes over. */}
            <aside
              className="hidden shrink-0 flex-col border-r border-neutral-200 bg-white px-3 py-4 lg:flex"
              style={{ width: 'var(--shell-sidebar-width)' }}
              aria-label="Sidebar"
            >
              <SidebarNav items={nav} />
            </aside>
            <main id="main" className="min-w-0 flex-1">
              <GmailReconnectBanner />
              <TrengoTokenBanner />
              <BackfillProgressBanner />
              <div className="px-4 py-4 sm:px-6 sm:py-6">{children}</div>
            </main>
          </div>
        </div>
      </ComposeEmailProvider>
    </ConfirmProvider>
  )
}
