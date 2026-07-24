// Summer Camp — Instalments tracker. Our own DB-backed view of camp bookings
// with deposit / remaining-balance tracking, imported from the booking CSV.
// Lives in the Summer Camp section only (CLAUDE.md §15 sibling).

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { CampsNav } from '../CampsNav'
import { InstalmentsWorkspace } from './InstalmentsWorkspace'

export const dynamic = 'force-dynamic'

const WRITE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'])

export default async function CampInstalmentsPage() {
  const me = await getCurrentUser()
  const canWrite = Boolean(me && WRITE_ROLES.has(me.role))

  return (
    <>
      <PageHeader
        title="Summer Camp · Instalments"
        subtitle="Track who has paid a deposit and what's still owed. Import the booking CSV, filter to instalment payers, and record further payments."
      />
      <PageBody>
        <CampsNav />
        <InstalmentsWorkspace canWrite={canWrite} />
      </PageBody>
    </>
  )
}
