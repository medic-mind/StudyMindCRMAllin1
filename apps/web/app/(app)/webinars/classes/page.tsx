// Classes list. One class per subject + level within an academic year. Create
// classes from the catalogue-driven workflow, see Zoom-rotation + current-week
// status, and drill into a class to manage its syllabus, Zoom link and list.

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
  const [classes, cohorts, subjects, levels] = await Promise.all([
    caller.webinar.class.list({}),
    caller.webinar.cohort.list(),
    caller.webinar.subject.pickList(),
    caller.webinar.level.pickList(),
  ])

  return (
    <>
      <PageHeader
        title="Classes"
        subtitle="Weekly live classes. Each is a subject at a level/type within an academic year."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Classes', href: '/webinars/classes' },
        ]}
      />
      <PageBody>
        <ClassesManager
          initialClasses={classes}
          initialCohorts={cohorts}
          initialSubjects={subjects}
          initialLevels={levels}
          canManage={MANAGE.has(me?.role ?? '')}
        />
      </PageBody>
    </>
  )
}
