// Unassigned Slack mentions tray (ADR 0034). Customer references the AI found
// in watched Slack channels but couldn't confidently match — assign each to a
// customer (writes the durable record) or dismiss. Never auto-matches (§12).

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { SlackMentionsTray } from './SlackMentionsTray'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

export default async function SlackMentionsPage() {
  const user = await getCurrentUser()
  const canManage = user ? MANAGE_ROLES.has(user.role) : false
  return (
    <>
      <PageHeader
        title="Unassigned Slack mentions"
        subtitle="Customer references picked up in watched Slack channels that need a human to match. Assigning one saves the original message on that customer's timeline."
        breadcrumbs={[
          { label: 'Slack mentions', href: '/inbox/slack-mentions' },
        ]}
      />
      <PageBody>
        <SlackMentionsTray canManage={canManage} />
      </PageBody>
    </>
  )
}
