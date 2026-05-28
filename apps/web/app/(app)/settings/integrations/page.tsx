// Settings → Integrations index. Grid of provider cards linking to a
// per-provider detail page. Read-only and gated to ceo | senior_manager |
// manager (ADR 0014). Sales Executives and Virtual Assistants do not see
// Settings at all (sidebar visibility in apps/web/app/(app)/layout.tsx).
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

function statusBadge(provider: {
  envVarsAllSet: boolean
  lastReceivedAt: Date | null
}): { tone: string; label: string } {
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
            You need the Manager, Senior Manager, or CEO role to view
            integrations.
          </p>
        </PageBody>
      </>
    )
  }

  const caller = await createServerCaller()
  const data = await caller.admin.integrations.status()

  return (
    <>
      <PageHeader
        title="Integrations"
        breadcrumbs={BREADCRUMBS}
        subtitle="Connection status, last received webhook, and configuration health for every external service the CRM speaks to."
      />
      <PageBody>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.providers.map((p) => {
            const badge = statusBadge(p)
            return (
              <li
                key={p.provider}
                className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card"
              >
                <Link
                  href={`/settings/integrations/${p.provider}`}
                  className="group block"
                >
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
        </ul>
      </PageBody>
    </>
  )
}
