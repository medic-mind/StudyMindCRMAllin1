// Dashboard at /. RSC. A single pane of glass over the whole CRM as it stands
// today: four role-aware KPI tiles, a "Needs attention" grid of action queues
// across every work surface (Trengo, calls, leads, complaints, Slack, finance,
// Direct Debits…), recent audited activity, the live at-risk-customers list,
// and an "Explore the workspace" jump-to grid. Powered by `dashboard.summary`
// (single round-trip). CLAUDE.md §26 (RSC default), §28 (skeleton in
// loading.tsx), §20 (role-aware).

import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { getCurrentUser } from '@/lib/auth/server'

import { AtRiskCustomersList } from '@/components/dashboard/at-risk-customers'
import { KpiTile } from '@/components/dashboard/kpi-tile'
import { QueueCard } from '@/components/dashboard/queue-card'
import { QuickLinks } from '@/components/dashboard/quick-links'
import { RecentActivity } from '@/components/dashboard/recent-activity'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import {
  AlertTriangleIcon,
  InboxIcon,
  ListTodoIcon,
  UsersIcon,
} from '@/components/ui/icon'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

const KPI_ICONS: Record<string, ReactNode> = {
  listTodo: <ListTodoIcon size={18} />,
  inbox: <InboxIcon size={18} />,
  alertTriangle: <AlertTriangleIcon size={18} />,
  users: <UsersIcon size={18} />,
}

export default async function DashboardPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')

  const trpc = await createServerCaller()
  const data = await trpc.dashboard.summary({})

  const allClear = data.queues.every((q) => q.count === 0)

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome back${me.name ? `, ${me.name.split(' ')[0]}` : ''} — here is what needs your attention today.`}
      />
      <PageBody>
        <div className="space-y-8">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.kpis.map((kpi) => (
              <KpiTile
                key={kpi.key}
                label={kpi.label}
                value={kpi.value}
                tone={kpi.tone}
                hint={kpi.hint}
                href={kpi.href}
                icon={KPI_ICONS[kpi.icon]}
              />
            ))}
          </div>

          {/* Needs attention — action queues across every surface */}
          <section aria-labelledby="queues-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2
                id="queues-heading"
                className="text-sm font-semibold uppercase tracking-wide text-neutral-600"
              >
                Needs attention
              </h2>
              {allClear ? (
                <span className="text-xs font-medium text-emerald-600">
                  All queues clear
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.queues.map((q) => (
                <QueueCard
                  key={q.key}
                  label={q.label}
                  count={q.count}
                  href={q.href}
                  tone={q.tone}
                  icon={q.icon}
                />
              ))}
            </div>
          </section>

          {/* Recent activity + at-risk customers */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section aria-labelledby="recent-activity-heading">
              <h2
                id="recent-activity-heading"
                className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600"
              >
                Recent activity
              </h2>
              <RecentActivity rows={data.activity} />
            </section>
            <section aria-labelledby="at-risk-heading">
              <h2
                id="at-risk-heading"
                className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600"
              >
                At-risk customers
              </h2>
              <AtRiskCustomersList rows={data.atRiskCustomers} />
            </section>
          </div>

          {/* Explore the workspace */}
          <section aria-labelledby="explore-heading">
            <h2
              id="explore-heading"
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600"
            >
              Explore the workspace
            </h2>
            <QuickLinks role={me.role} />
          </section>
        </div>
      </PageBody>
    </>
  )
}
