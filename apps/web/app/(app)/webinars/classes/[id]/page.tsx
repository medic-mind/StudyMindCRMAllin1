// Class detail: weekly slot, Zoom link + rotation, syllabus (generate or upload
// a PDF), the computed term schedule, and this class's enrolments.

import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { ClassDetail } from './ClassDetail'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  let detail
  try {
    detail = await caller.webinar.class.get({ id })
  } catch {
    notFound()
  }
  const enrollments = await caller.webinar.enrollment.list({ classId: id })

  return (
    <>
      <PageHeader
        title={`${detail.subjectLabel} ${detail.levelLabel}`}
        subtitle={`${detail.cohortName} · ${detail.title}`}
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Classes', href: '/webinars/classes' },
          { label: `${detail.subjectLabel} ${detail.levelLabel}`, href: `/webinars/classes/${id}` },
        ]}
      />
      <PageBody>
        <ClassDetail
          detail={detail}
          enrollments={enrollments}
          canManage={MANAGE.has(me?.role ?? '')}
        />
      </PageBody>
    </>
  )
}
