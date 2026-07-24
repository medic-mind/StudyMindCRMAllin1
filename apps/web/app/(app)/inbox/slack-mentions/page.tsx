// Slack mentions tray (ADR 0034). Customer references picked up in watched
// Slack channels are matched to a customer, filed on their timeline, or
// (when nothing matches) auto-dismissed — all automatically. This page is the
// rare fallback view; in normal running it stays empty (§12).

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { SlackMentionsTray } from './SlackMentionsTray'

export const dynamic = 'force-dynamic'

export default async function SlackMentionsPage() {
  return (
    <>
      <PageHeader
        title="Slack mentions (automated)"
        subtitle="Slack messages about a customer are matched and filed on that customer's timeline automatically. This page is just where anything that can't be placed would land — normally it's empty, and nothing here waits for you to action it."
        breadcrumbs={[{ label: 'Slack mentions', href: '/inbox/slack-mentions' }]}
      />
      <PageBody>
        <SlackMentionsTray />
      </PageBody>
    </>
  )
}
