// Leads tray (ADR 0023). Incoming web enquiries, auto-classified and routed to
// the Sales Pipeline. Most leads onboard automatically (first contact) or
// dedupe onto an existing contact (re-enquiry); this tray is the light review
// surface for what came in and the few that need a human (needs_triage).

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
        title="Leads"
        subtitle="Incoming web enquiries — auto-classified by brand, product and intent, then routed to the pipeline."
      />
      <PageBody>
        <LeadsTray initialStats={stats} canWrite={Boolean(me && WRITE_ROLES.has(me.role))} />
      </PageBody>
    </>
  )
}
