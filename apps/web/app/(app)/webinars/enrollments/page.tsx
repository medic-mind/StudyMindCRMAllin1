// Enrolments. Run the Stripe organiser, work the review queue, and manage every
// enrolment across all classes.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { EnrollmentsManager } from './EnrollmentsManager'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function EnrollmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const sp = await searchParams
  const view = sp.view === 'review' ? 'review' : sp.view === 'active' ? 'active' : 'all'
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const [all, review] = await Promise.all([
    caller.webinar.enrollment.list({}),
    caller.webinar.enrollment.list({ status: 'pending_review' }),
  ])

  return (
    <>
      <PageHeader
        title="Enrolments"
        subtitle="Stripe payers organised into classes. Confident matches enrol automatically; the rest wait here for a quick confirm."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Enrolments', href: '/webinars/enrollments' },
        ]}
      />
      <PageBody>
        <EnrollmentsManager
          initialAll={all}
          initialReview={review}
          initialView={view}
          canManage={MANAGE.has(me?.role ?? '')}
        />
      </PageBody>
    </>
  )
}
