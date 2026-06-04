// Classes list. One class per subject + level within a cohort. Create classes,
// see Zoom-rotation status, and drill into a class to manage its syllabus,
// Zoom link and enrolments.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { ClassesManager } from './ClassesManager'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function ClassesPage() {
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const [classes, cohorts] = await Promise.all([
    caller.webinar.class.list({}),
    caller.webinar.cohort.list(),
  ])

  return (
    <>
      <PageHeader
        title="Classes"
        subtitle="Weekly live classes. Each is a subject at a level within a cohort."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Classes', href: '/webinars/classes' },
        ]}
      />
      <PageBody>
        <ClassesManager
          initialClasses={classes}
          cohorts={cohorts.map((c) => ({ id: c.id, name: c.name, status: c.status }))}
          canManage={MANAGE.has(me?.role ?? '')}
        />
      </PageBody>
    </>
  )
}
