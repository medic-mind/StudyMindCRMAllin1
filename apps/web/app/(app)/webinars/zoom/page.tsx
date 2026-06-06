// Zoom links area — one place to set/update the join link for every class. The
// CRM reminds the team to rotate links on their interval (default 4 weeks) so a
// lapsed member can't keep joining on an old link.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { ZoomLinksManager } from './ZoomLinksManager'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function ZoomLinksPage() {
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const classes = await caller.webinar.class.list({})

  return (
    <>
      <PageHeader
        title="Zoom links"
        subtitle="Set each class's join link. Reminders use the current link; the team is alerted to rotate stale ones."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Zoom links', href: '/webinars/zoom' },
        ]}
      />
      <PageBody>
        <ZoomLinksManager initial={classes} canManage={MANAGE.has(me?.role ?? '')} />
      </PageBody>
    </>
  )
}
