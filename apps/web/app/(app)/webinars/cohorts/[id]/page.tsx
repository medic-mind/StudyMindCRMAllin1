// Cohort detail — the cohort-centric workspace: its classes (create + open
// each) and its holiday breaks, in one place. Each class opens its own page
// with schedule (AI + PDF), Zoom, enrolments and emails.

import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { CohortDetail } from './CohortDetail'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function CohortDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  let cohort
  try {
    cohort = await caller.webinar.cohort.get({ id })
  } catch {
    notFound()
  }

  return (
    <>
      <PageHeader
        title={cohort.name}
        subtitle={`${cohort.startsOn} → ${cohort.endsOn} · ${cohort.timezone}`}
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Cohorts', href: '/webinars/cohorts' },
          { label: cohort.name, href: `/webinars/cohorts/${id}` },
        ]}
      />
      <PageBody>
        <CohortDetail cohort={cohort} canManage={MANAGE.has(me?.role ?? '')} />
      </PageBody>
    </>
  )
}
