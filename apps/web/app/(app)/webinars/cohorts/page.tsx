// Cohorts & holidays. Create academic years (2026/2027 and beyond) and manage
// the holiday breaks during which no class emails are sent.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { CohortsManager } from './CohortsManager'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function CohortsPage() {
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const cohorts = await caller.webinar.cohort.list()

  return (
    <>
      <PageHeader
        title="Cohorts & holidays"
        subtitle="Each cohort is an academic year. Holidays inside a cohort pause the weekly emails."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Cohorts', href: '/webinars/cohorts' },
        ]}
      />
      <PageBody>
        <CohortsManager initialCohorts={cohorts} canManage={MANAGE.has(me?.role ?? '')} />
      </PageBody>
    </>
  )
}
