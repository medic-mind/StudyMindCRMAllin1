// Dashboard at /. RSC. A single pane of glass over the whole CRM as it stands
// today: a brand greeting hero with a smart "what needs you" summary, four
// role-aware KPI tiles, a "Needs attention" grid of action queues across every
// work surface (Trengo, calls, leads, complaints, Slack, finance, Direct
// Debits…), recent audited activity, the live at-risk-customers list, and an
// "Explore the workspace" jump-to grid. Powered by `dashboard.summary` (single
// round-trip). CLAUDE.md §26 (RSC default), §28 (skeleton in loading.tsx,
// gentle motion), §20 (role-aware), §29 (Europe/London clock).

import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

import { getCurrentUser } from '@/lib/auth/server'

import { AtRiskCustomersList } from '@/components/dashboard/at-risk-customers'
import { GreetingHero } from '@/components/dashboard/greeting-hero'
import { KpiTile } from '@/components/dashboard/kpi-tile'
import { QueueCard } from '@/components/dashboard/queue-card'
import { QuickLinks } from '@/components/dashboard/quick-links'
import { RecentActivity } from '@/components/dashboard/recent-activity'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import {
  AlertTriangleIcon,
  CheckCircleIcon,
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

const LONDON = 'Europe/London'

function SectionHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="text-sm font-semibold uppercase tracking-wide text-neutral-600"
    >
      {children}
    </h2>
  )
}

export default async function DashboardPage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')

  const trpc = await createServerCaller()
  const data = await trpc.dashboard.summary({})

  // Greeting + date on the Europe/London clock (CLAUDE.md §29).
  const now = new Date()
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: LONDON,
    }).format(now),
  )
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: LONDON,
  }).format(now)
  const firstName = me.name ? me.name.split(' ')[0] ?? null : null

  // "What needs you" — the KPI actionables (Trengo / tasks / at-risk) plus
  // every queue, deduped into one honest total and a single best CTA.
  const kpiByKey = new Map(data.kpis.map((k) => [k.key, k.value] as const))
  const conversations = kpiByKey.get('conversations') ?? 0
  const tasks = kpiByKey.get('tasks') ?? 0
  const atRiskTotal = kpiByKey.get('atRisk') ?? 0
  const queueTotal = data.queues.reduce((sum, q) => sum + q.count, 0)
  const attentionTotal = queueTotal + conversations + tasks + atRiskTotal

  const actionables = [
    ...data.queues.map((q) => ({ label: q.label, href: q.href, count: q.count })),
    { label: 'Trengo inbox', href: '/inbox', count: conversations },
    { label: 'your tasks', href: '/tasks', count: tasks },
    { label: 'at-risk customers', href: '/contacts/at-risk', count: atRiskTotal },
  ]
  const top = actionables.filter((a) => a.count > 0).sort((a, b) => b.count - a.count)[0]
  const topAction = top ? { label: top.label, href: top.href } : null

  return (
    <>
      <PageHeader title="Dashboard" />
      <PageBody>
        <div className="space-y-8">
          <GreetingHero
            greeting={greeting}
            name={firstName}
            dateLabel={dateLabel}
            attentionTotal={attentionTotal}
            topAction={topAction}
          />

          {/* KPI row */}
          <div className="animate-rise-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          <section aria-labelledby="queues-heading" className="animate-rise-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <SectionHeading id="queues-heading">Needs attention</SectionHeading>
              {queueTotal > 0 ? (
                <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-neutral-600">
                  {queueTotal} open
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                  <CheckCircleIcon size={14} />
                  All clear
                </span>
              )}
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
          <div className="animate-rise-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <RecentActivity rows={data.activity} />
            <AtRiskCustomersList rows={data.atRiskCustomers} total={atRiskTotal} />
          </div>

          {/* Explore the workspace */}
          <section aria-labelledby="explore-heading" className="animate-rise-4">
            <div className="mb-3">
              <SectionHeading id="explore-heading">Explore the workspace</SectionHeading>
            </div>
            <QuickLinks role={me.role} />
          </section>
        </div>
      </PageBody>
    </>
  )
}
