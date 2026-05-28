// Settings → Teams (CEO + Senior Manager). Create teams, manage members.
// CLAUDE.md §20.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { TeamsAdmin } from './TeamsAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Teams', href: '/settings/teams' },
]

export default async function TeamsSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Teams" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to CEO and Senior Manager.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Teams"
        subtitle="Group ops staff into squads so tasks can be scoped per team"
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <TeamsAdmin />
      </PageBody>
    </>
  )
}
