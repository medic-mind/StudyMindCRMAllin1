// Settings landing page. Sub-areas are role-gated on their own pages.

import Link from 'next/link'

const links: Array<{ href: string; title: string; description: string; roles: string }> = [
  {
    href: '/settings/users',
    title: 'Users & roles',
    description: 'List users, assign and revoke roles. Audited.',
    roles: 'admin',
  },
  {
    href: '/settings/flags',
    title: 'Feature flags',
    description: 'Effective values, env overrides, stale release flags.',
    roles: 'admin · ops_manager',
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
    roles: 'admin · ops_manager',
  },
]

export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="block rounded-md border border-neutral-200 bg-white p-4 hover:border-neutral-300"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{l.title}</h2>
              <span className="text-xs text-neutral-500">{l.roles}</span>
            </div>
            <p className="mt-1 text-sm text-neutral-600">{l.description}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
