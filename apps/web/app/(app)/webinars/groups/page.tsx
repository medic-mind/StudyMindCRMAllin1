// Groups — the primary webinars screen. A "group" is one subject + level
// offering (e.g. A-Level Biology) with its own weekly classes, Zoom link,
// template, settings and students (backed by WebinarClass). Replaces the old
// cohort-first navigation.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { GroupsManager } from './GroupsManager'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function GroupsPage() {
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const groups = await caller.webinar.class.list()

  return (
    <>
      <PageHeader
        title="Groups"
        subtitle="Each group is one subject + level — its weekly classes, Zoom link, email template, settings and students all live inside it. Import a timetable to set one up in seconds."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Groups', href: '/webinars/groups' },
        ]}
      />
      <PageBody>
        <GroupsManager initialGroups={groups} canManage={MANAGE.has(me?.role ?? '')} />
      </PageBody>
    </>
  )
}
