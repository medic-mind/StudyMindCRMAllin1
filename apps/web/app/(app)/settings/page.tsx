// Settings landing page. Sub-areas are role-gated on their own pages.

import Link from 'next/link'

import { PageHeader } from '@/components/shell/page-header'

const links: Array<{ href: string; title: string; description: string; roles: string }> = [
  {
    href: '/settings/users',
    title: 'Users & roles',
    description: 'List users, assign and revoke roles. Audited.',
    roles: 'CEO · Senior Manager',
  },
  {
    href: '/settings/teams',
    title: 'Teams',
    description: 'Group ops staff into squads. Tasks can be scoped per team.',
    roles: 'CEO · Senior Manager',
  },
  {
    href: '/settings/companies',
    title: 'Companies',
    description:
      'Sister-brand tags shown across contacts (Medic Mind, Oxbridge Mind, Study Mind, anything you add).',
    roles: 'CEO · Senior Manager',
  },
  {
    href: '/settings/flags',
    title: 'Feature flags',
    description: 'Effective values, env overrides, stale release flags.',
    roles: 'CEO · Senior Manager',
  },
  {
    href: '/settings/branding',
    title: 'Branding',
    description: 'Upload the logo shown in the top bar and on sign-in.',
    roles: 'CEO · Senior Manager',
  },
  {
    href: '/settings/mailbox',
    title: 'Mailbox',
    description: 'Connect or disconnect your Gmail mailbox (per-agent).',
    roles: 'all',
  },
  {
    href: '/settings/integrations',
    title: 'Integrations status',
    description:
      'Webhook receive recency, Gmail watch expiry, Asana webhook health.',
    roles: 'CEO · Senior Manager',
  },
]

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="block rounded-xl border border-neutral-200 bg-white p-4 shadow-card transition-shadow hover:border-neutral-300 hover:shadow-card-hover"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{l.title}</h2>
              <span className="text-xs text-neutral-500">{l.roles}</span>
            </div>
            <p className="mt-1 text-sm text-neutral-600">{l.description}</p>
          </Link>
        ))}
      </div>
    </>
  )
}
