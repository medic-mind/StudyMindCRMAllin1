// Leads triage (ADR 0023). Incoming web enquiries are saved as Contacts
// automatically and routed to the Sales Pipeline. This page defaults to the
// few that a human needs to look at (needs_triage: no email/phone, or a
// possible duplicate) — the other tabs are an audit view over everything
// that came in. It is NOT a parallel home for leads; onboarded leads live as
// real Contacts + pipeline cards.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { LeadsTray } from './LeadsTray'

export const dynamic = 'force-dynamic'

const WRITE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

export default async function LeadsPage() {
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const stats = await caller.lead.stats()

  return (
    <>
      <PageHeader
        title="Web enquiries"
        subtitle="Every enquiry is handled automatically — saved as a customer (or added to the existing one) and dropped onto the pipeline. This page is the log of what happened."
      />
      <PageBody>
        <LeadsTray initialStats={stats} canWrite={Boolean(me && WRITE_ROLES.has(me.role))} />
      </PageBody>
    </>
  )
}
