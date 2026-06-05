// Settings → Slack channels (Manager+). Operator-managed Slack channels the
// call-summary "Internal — Slack" section can post to, each with optional
// deep-link action buttons for virtual assistants. CLAUDE.md §10/§12, §20.1.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { SlackChannelsAdmin } from './SlackChannelsAdmin'
import { SlackRoutesAdmin } from './SlackRoutesAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Slack channels', href: '/settings/slack-channels' },
]

export default async function SlackChannelsSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Slack channels" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">Restricted to Manager and above.</p>
        </PageBody>
      </>
    )
  }
  return (
    <>
      <PageHeader
        title="Slack channels"
        subtitle="Manage the channels the CRM posts to, and route each kind of notification to the channel you want — no code change needed."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <div className="space-y-6">
          <SlackChannelsAdmin />
          <SlackRoutesAdmin />
        </div>
      </PageBody>
    </>
  )
}
