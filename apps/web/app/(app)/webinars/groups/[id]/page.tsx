// Group workspace — everything for one subject + level offering in one place:
// this week, Zoom link, the weekly classes (schedule), students, the reminder
// email, term dates + holidays, and delete. Backed by WebinarClass; the
// academic year (cohort) is surfaced here as settings, not a separate screen.

import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { GroupExtras } from '../GroupExtras'
import { GroupWorkspace } from '../GroupWorkspace'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function GroupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  let detail
  try {
    detail = await caller.webinar.class.get({ id })
  } catch {
    notFound()
  }
  const [enrollments, cohort] = await Promise.all([
    caller.webinar.enrollment.list({ classId: id }),
    caller.webinar.cohort.get({ id: detail.cohortId }),
  ])
  const canManage = MANAGE.has(me?.role ?? '')

  return (
    <>
      <PageHeader
        title={`${detail.subjectLabel} ${detail.levelLabel}`}
        subtitle={detail.title}
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Groups', href: '/webinars/groups' },
          { label: `${detail.subjectLabel} ${detail.levelLabel}`, href: `/webinars/groups/${id}` },
        ]}
      />
      <PageBody>
        <div className="space-y-5">
          <GroupWorkspace detail={detail} enrollments={enrollments} canManage={canManage} />
          <GroupExtras detail={detail} cohort={cohort} canManage={canManage} />
        </div>
      </PageBody>
    </>
  )
}
