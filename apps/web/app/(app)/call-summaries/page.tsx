// Call Summaries — a top-level place to submit a call summary for anyone, even
// someone not yet on the CRM. A smart de-dup guard aligns the summary with an
// existing contact (name / phone / email) before a duplicate is created; the
// send/hand-off then runs through the shared CallSummaryWizard. RSC shell; the
// entry form + queue are a client island. All staff. CLAUDE.md §3, §41.1.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { CallSummariesWorkspace } from './CallSummariesWorkspace'

export const dynamic = 'force-dynamic'

export default function CallSummariesPage() {
  return (
    <>
      <PageHeader
        title="Call Summaries"
        subtitle="Log a call with anyone. We match them to an existing contact automatically — or create a new one — so summaries never duplicate a customer."
      />
      <PageBody>
        <CallSummariesWorkspace />
      </PageBody>
    </>
  )
}
