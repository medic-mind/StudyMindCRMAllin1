// Dashboard at /. RSC. Renders four KPI tiles, recent activity, and the
// at-risk panel. Powered by `dashboard.summary` (single round-trip).
//
// Replaces the previous redirect-to-/inbox shim. CLAUDE.md §26 (RSC
// default), §28 (skeleton sized in loading.tsx), §20 (role-aware tile).

import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'

import { AtRiskList } from '@/components/dashboard/at-risk-list'
import { KpiTile } from '@/components/dashboard/kpi-tile'
import { RecentActivity } from '@/components/dashboard/recent-activity'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  CoinsIcon,
  ListTodoIcon,
  UsersIcon,
} from '@/components/ui/icon'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'
export const revalidate = 30

export default async function DashboardPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')

  const trpc = await createServerCaller()
  const data = await trpc.dashboard.summary({})

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome back${me.name ? `, ${me.name.split(' ')[0]}` : ''}. Here is the state of StudyMind today.`}
      />
      <PageBody>
        <div className="space-y-6">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label={data.kpis.activeFamilies.label}
              value={data.kpis.activeFamilies.value}
              delta={data.kpis.activeFamilies.delta}
              deltaSemantics="up_is_good"
              tone="info"
              icon={<UsersIcon size={18} />}
              hint="Trial + active states"
            />
            <KpiTile
              label={data.kpis.openDiscrepancies.label}
              value={data.kpis.openDiscrepancies.value}
              delta={data.kpis.openDiscrepancies.delta}
              deltaSemantics="up_is_bad"
              tone={
                data.kpis.openDiscrepancies.value === 0
                  ? 'success'
                  : data.kpis.openDiscrepancies.value > 10
                    ? 'danger'
                    : 'warn'
              }
              icon={
                data.kpis.openDiscrepancies.value === 0 ? (
                  <CheckCircleIcon size={18} />
                ) : (
                  <AlertTriangleIcon size={18} />
                )
              }
              hint="Reconciliation"
            />
            <KpiTile
              label={data.kpis.tasksDueToday.label}
              value={data.kpis.tasksDueToday.value}
              tone={data.kpis.tasksDueToday.value === 0 ? 'success' : 'warn'}
              icon={<ListTodoIcon size={18} />}
              hint="Assigned to you"
            />
            <KpiTile
              label={data.kpis.fourth.label}
              value={data.kpis.fourth.value}
              tone="neutral"
              icon={<CoinsIcon size={18} />}
              hint="Drift sample × 100"
            />
          </div>

          {/* Two panels */}
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
                At-risk families
              </h2>
              <AtRiskList rows={data.atRisk} />
            </section>
          </div>
        </div>
      </PageBody>
    </>
  )
}
