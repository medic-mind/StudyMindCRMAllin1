// At-risk customers dashboard. Surfaces customers whose booked tutoring hours
// are at risk of expiring unused (hours expire 12 months after booking — we
// reach out before they lapse to avoid complaints). Risk LEVEL is derived
// (deriveHoursRisk, CLAUDE.md §6.4); the human triage (flag / dismiss) and
// follow-up tasks are persisted. Not cursor-paginated — the population
// (customers holding a balance) is naturally small.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { AtRiskDashboard } from './AtRiskDashboard'

export const dynamic = 'force-dynamic'

type View = 'open' | 'flagged' | 'dismissed' | 'all'

interface PageProps {
  searchParams: Promise<{ level?: string; view?: string }>
}

export default async function AtRiskCustomersPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const minLevel = sp.level === 'high' || sp.level === 'low' ? sp.level : 'medium'
  const view: View =
    sp.view === 'flagged' || sp.view === 'dismissed' || sp.view === 'all' ? sp.view : 'open'
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const caller = await createServerCaller()
  const { items, counts } = await caller.customerRisk.list({ minLevel, view, limit: 300 })

  return (
    <>
      <PageHeader
        title="At-risk customers"
        subtitle="Customers sitting on booked hours they aren't using. Hours expire 12 months after booking — flag them and create a follow-up before they lapse."
        breadcrumbs={[
          { label: 'B2C Customers', href: '/contacts' },
          { label: 'At risk', href: '/contacts/at-risk' },
        ]}
      />
      <PageBody>
        <AtRiskDashboard
          items={items}
          counts={counts}
          minLevel={minLevel}
          view={view}
          role={role}
        />
      </PageBody>
    </>
  )
}
