// Settings → Integrations index. The single hub for every external service the
// CRM speaks to. Webhook providers show live connection status (from
// admin.integrations.status); related configuration pages that live elsewhere
// (B2B invoicing, email accounts, Slack routing) are surfaced here too so this
// is the one place to find any integration. Grouped by purpose.
//
// Read-only and gated to ceo | senior_manager | manager (ADR 0014).
// CLAUDE.md §11, §13, §14, §25.

import Link from 'next/link'

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Integrations', href: '/settings/integrations' },
]

const VIEW_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

// Order the category sections render in.
const CATEGORY_ORDER = [
  'Payments & finance',
  'Communications',
  'Productivity',
  'Booking & data',
  'Lead capture',
] as const

// Related configuration that lives on its own page but belongs to an
// integration — surfaced here so Integrations is the single front door. These
// are plain links (no webhook status of their own).
const LINKED_SETTINGS: ReadonlyArray<{
  category: string
  label: string
  href: string
  description: string
}> = [
  {
    category: 'Payments & finance',
    label: 'B2B Invoicing (b2b.studymind.co.uk)',
    href: '/settings/invoicing',
    description: 'Connection + two-way sync settings for the B2B invoicing platform.',
  },
  {
    category: 'Communications',
    label: 'Email accounts',
    href: '/settings/email-accounts',
    description: 'Connected mailboxes — personal inboxes and shared team inboxes (Gmail today).',
  },
  {
    category: 'Communications',
    label: 'Slack notifications',
    href: '/settings/slack-channels',
    description: 'Which Slack channel each kind of CRM alert posts to.',
  },
]

export const dynamic = 'force-dynamic'

function timeAgo(d: Date | null): string {
  if (!d) return 'never'
  const ms = Date.now() - d.getTime()
  const min = Math.floor(ms / (1000 * 60))
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

function statusBadge(provider: { envVarsAllSet: boolean }): { tone: string; label: string } {
  if (!provider.envVarsAllSet) {
    return { tone: 'bg-neutral-100 text-neutral-700', label: 'Not configured' }
  }
  return { tone: 'bg-emerald-100 text-emerald-900', label: 'Connected' }
}

export default async function IntegrationsSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !VIEW_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Integrations" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need the Manager, Senior Manager, or CEO role to view integrations.
          </p>
        </PageBody>
      </>
    )
  }

  const caller = await createServerCaller()
  const data = await caller.admin.integrations.status()

  // Bucket providers + linked settings by category.
  const categories = new Set<string>([
    ...CATEGORY_ORDER,
    ...data.providers.map((p) => p.category),
    ...LINKED_SETTINGS.map((l) => l.category),
  ])
  const ordered = [
    ...CATEGORY_ORDER.filter((c) => categories.has(c)),
    ...[...categories].filter((c) => !CATEGORY_ORDER.includes(c as (typeof CATEGORY_ORDER)[number])),
  ]

  return (
    <>
      <PageHeader
        title="Integrations"
        breadcrumbs={BREADCRUMBS}
        subtitle="Every external service the CRM speaks to — connection status, recent activity, and the related configuration pages, in one place."
      />
      <PageBody>
        <div className="space-y-8">
          {ordered.map((category) => {
            const providers = data.providers.filter((p) => p.category === category)
            const linked = LINKED_SETTINGS.filter((l) => l.category === category)
            if (providers.length === 0 && linked.length === 0) return null
            return (
              <section key={category}>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {category}
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {providers.map((p) => {
                    const badge = statusBadge(p)
                    return (
                      <li
                        key={p.provider}
                        className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card"
                      >
                        <Link href={`/settings/integrations/${p.provider}`} className="group block">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-semibold text-neutral-900 group-hover:underline">
                                {p.label}
                              </div>
                              <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-neutral-500">
                                {p.provider}
                              </div>
                            </div>
                            <span
                              className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${badge.tone}`}
                            >
                              {badge.label}
                            </span>
                          </div>
                          <p className="mt-3 text-xs text-neutral-600">{p.description}</p>
                          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <dt className="text-neutral-500">Last event</dt>
                              <dd className="font-mono tabular-nums text-neutral-800">
                                {timeAgo(p.lastReceivedAt)}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-neutral-500">Last type</dt>
                              <dd className="truncate font-mono text-neutral-800">
                                {p.lastEventType ?? '—'}
                              </dd>
                            </div>
                          </dl>
                        </Link>
                      </li>
                    )
                  })}

                  {linked.map((l) => (
                    <li
                      key={l.href}
                      className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card"
                    >
                      <Link href={l.href} className="group block">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-sm font-semibold text-neutral-900 group-hover:underline">
                            {l.label}
                          </div>
                          <span className="shrink-0 rounded bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700">
                            Manage →
                          </span>
                        </div>
                        <p className="mt-3 text-xs text-neutral-600">{l.description}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </PageBody>
    </>
  )
}
