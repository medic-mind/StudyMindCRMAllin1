// Settings landing page. Grouped into People / Brand & Data / Workflows /
// Platform so admins can find what they need at a glance. Per-agent security
// (2FA + Sessions) lives in the user menu; the per-agent mailbox is surfaced
// both there and as a Platform tile here.

import Link from 'next/link'

import { PageHeader } from '@/components/shell/page-header'
import {
  BarChartIcon,
  BuildingIcon,
  CoinsIcon,
  GitBranchIcon,
  MailIcon,
  SettingsIcon,
  ShieldAlertIcon,
  UsersIcon,
} from '@/components/ui/icon'

interface Tile {
  href: string
  title: string
  description: string
  roles: string
  icon: React.ReactNode
}

interface Group {
  title: string
  description?: string
  tiles: Tile[]
}

const GROUPS: Group[] = [
  {
    title: 'People & Access',
    description: 'Who can use the CRM and what they can do.',
    tiles: [
      {
        href: '/settings/users',
        title: 'Users & roles',
        description:
          'Create accounts, reissue logins, delete/erase, roles, individual permissions, avatars. Audited.',
        roles: 'CEO · SM · Manager',
        icon: <UsersIcon size={16} />,
      },
      {
        href: '/settings/teams',
        title: 'Teams',
        description: 'Group ops staff into squads. Tasks can be scoped per team.',
        roles: 'CEO · Senior Manager',
        icon: <UsersIcon size={16} />,
      },
      {
        href: '/settings/roles',
        title: 'Roles & permissions',
        description: 'Create custom roles and assign permissions on top of the built-in roles.',
        roles: 'CEO · Senior Manager',
        icon: <ShieldAlertIcon size={16} />,
      },
    ],
  },
  {
    title: 'Brand & Data',
    description: 'Tags, brand identity, and what families see.',
    tiles: [
      {
        href: '/settings/companies',
        title: 'Companies',
        description: 'Sister-brand tags (Medic Mind, Oxbridge Mind, StudyMind, anything you add).',
        roles: 'CEO · Senior Manager',
        icon: <CoinsIcon size={16} />,
      },
      {
        href: '/settings/branding',
        title: 'Branding',
        description: 'Upload the logo shown in the top bar and on sign-in.',
        roles: 'CEO · Senior Manager',
        icon: <SettingsIcon size={16} />,
      },
    ],
  },
  {
    title: 'Workflows',
    description: 'Quick actions the agents trigger from a contact.',
    tiles: [
      {
        href: '/settings/forwarding',
        title: 'Forwarding rules',
        description:
          'Configure the “Forward to <team>” quick actions (AP team, CEOs, schools, partnerships).',
        roles: 'Manager+',
        icon: <MailIcon size={16} />,
      },
      {
        href: '/settings/call-summary-templates',
        title: 'Call summary templates',
        description:
          'Prefill templates for the contact page Call Summary panel (UCAT, Medical Interview, Dental Interview…). Optionally carries an attached PDF.',
        roles: 'Manager+',
        icon: <MailIcon size={16} />,
      },
      {
        href: '/settings/documents',
        title: 'Documents',
        description:
          'Information packs and brochures (PDF) agents attach to call-summary emails. One library, picked at send time.',
        roles: 'Manager+',
        icon: <MailIcon size={16} />,
      },
      {
        href: '/settings/dd-recovery-templates',
        title: 'Direct Debit recovery',
        description:
          'The escalating email + text sequence for chasing an unpaid Direct Debit, plus the late fee, cadence and letterhead. Court fee + interest are calculated automatically.',
        roles: 'Manager+',
        icon: <CoinsIcon size={16} />,
      },
      {
        href: '/settings/slack-channels',
        title: 'Slack channels',
        description:
          'The Slack channels the CRM posts to (call-summary action points with deep-link buttons), and where each kind of notification is routed.',
        roles: 'Manager+',
        icon: <GitBranchIcon size={16} />,
      },
      {
        href: '/settings/quick-replies',
        title: 'Quick replies',
        description:
          'Canned responses agents insert into a conversation reply. Personalise with {{first_name}} / {{name}}.',
        roles: 'Manager+',
        icon: <MailIcon size={16} />,
      },
      {
        href: '/settings/account-labels',
        title: 'Labels',
        description:
          'Custom, colour-coded labels for customers and B2B accounts. Apply them in bulk from the Customers or Accounts lists.',
        roles: 'Manager+',
        icon: <BuildingIcon size={16} />,
      },
      {
        href: '/settings/board-quick-actions',
        title: 'Board quick actions',
        description:
          'Configure the per-card buttons on each board (Called once, Called twice, Invalid number…). Pick a board to manage its buttons.',
        roles: 'Manager+',
        icon: <GitBranchIcon size={16} />,
      },
    ],
  },
  {
    title: 'Platform',
    description: 'Operational state of the system itself.',
    tiles: [
      {
        href: '/settings/email-accounts',
        title: 'Email accounts',
        description:
          'Connect personal mailboxes and shared team inboxes (info@, admissions@…). The Communications Hub foundation (ADR 0021).',
        roles: 'all · Manager+ for shared',
        icon: <MailIcon size={16} />,
      },
      {
        href: '/settings/integrations',
        title: 'Integrations',
        description:
          'The hub for every external service — webhook status, plus B2B invoicing, email accounts and Slack routing.',
        roles: 'CEO · Senior Manager · Manager',
        icon: <BarChartIcon size={16} />,
      },
      {
        href: '/settings/invoicing',
        title: 'Invoicing',
        description:
          'Connect the B2B Invoices Platform (b2b.studymind.co.uk) for two-way invoice sync on account pages.',
        roles: 'CEO · Senior Manager · Manager',
        icon: <CoinsIcon size={16} />,
      },
      {
        href: '/settings/flags',
        title: 'Feature flags',
        description: 'Effective values, env overrides, stale release flags.',
        roles: 'CEO · Senior Manager',
        icon: <ShieldAlertIcon size={16} />,
      },
      {
        href: '/settings/mailbox',
        title: 'My mailboxes',
        description: 'Connect or disconnect your Gmail mailboxes (per-agent).',
        roles: 'all',
        icon: <MailIcon size={16} />,
      },
    ],
  },
]

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Organisation, brand, and platform configuration" />
      <div className="space-y-8">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <header className="mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-neutral-500">
                {group.title}
              </h2>
              {group.description ? (
                <p className="mt-0.5 text-xs text-neutral-500">{group.description}</p>
              ) : null}
            </header>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.tiles.map((t) => (
                <Link
                  key={t.href}
                  href={t.href}
                  className="group block rounded-xl border border-neutral-200 bg-white p-4 shadow-card transition-shadow hover:border-neutral-300 hover:shadow-card-hover"
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary-50 text-primary-700 transition-colors group-hover:bg-primary-100"
                    >
                      {t.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-medium text-neutral-900">{t.title}</h3>
                        <span className="shrink-0 text-[11px] text-neutral-500">{t.roles}</span>
                      </div>
                      <p className="mt-1 text-sm text-neutral-600">{t.description}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
