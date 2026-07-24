// Settings landing page. Grouped into People / Brand & Data / Workflows /
// Platform so admins can find what they need at a glance. The page list is the
// SHARED source of truth in ./settings-links.ts, which also drives the sidebar
// Settings sub-nav (so the two can never drift). Per-agent security (2FA +
// Sessions) and the per-agent mailbox live in the user menu (top-right);
// Email accounts + Invoicing live under Integrations.

import Link from 'next/link'
import type { ReactNode } from 'react'

import { getCurrentUser } from '@/lib/auth/server'
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

import { visibleSettingsGroups, type Role, type SettingsIconKey } from './settings-links'

const ICONS: Record<SettingsIconKey, ReactNode> = {
  users: <UsersIcon size={16} />,
  shield: <ShieldAlertIcon size={16} />,
  companies: <CoinsIcon size={16} />,
  branding: <SettingsIcon size={16} />,
  mail: <MailIcon size={16} />,
  coins: <CoinsIcon size={16} />,
  git: <GitBranchIcon size={16} />,
  building: <BuildingIcon size={16} />,
  integrations: <BarChartIcon size={16} />,
}

export default async function SettingsPage() {
  const me = await getCurrentUser()
  const role: Role = me?.role ?? 'virtual_assistant'
  const groups = visibleSettingsGroups(role)
  return (
    <>
      <PageHeader title="Settings" subtitle="Organisation, brand, and platform configuration" />
      <div className="space-y-8">
        {groups.map((group) => (
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
              {group.links.map((t) => (
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
                      {ICONS[t.icon]}
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
