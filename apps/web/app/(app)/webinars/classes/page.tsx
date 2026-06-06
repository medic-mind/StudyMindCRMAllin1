// Classes master list (a flat view across cohorts). The cohort-centric workflow
// lives at /webinars/cohorts; this stays as a quick "all classes" view.

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
  const classes = await caller.webinar.class.list({})

  return (
    <>
      <PageHeader
        title="All classes"
        subtitle="Every weekly class across cohorts. Manage a whole year together under Cohorts."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'All classes', href: '/webinars/classes' },
        ]}
      />
      <PageBody>
        <ClassesManager initialClasses={classes} canManage={MANAGE.has(me?.role ?? '')} />
      </PageBody>
    </>
  )
}
