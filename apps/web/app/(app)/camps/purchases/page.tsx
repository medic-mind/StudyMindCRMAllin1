// Summer Camp — Stripe purchases. Payments whose Stripe product text matched
// "summer camp" / "work experience" are detected automatically off the
// charge.succeeded pipeline and turned into camp bookings THROUGH the CRM.
// This tray is the human control surface: pending rows (camp not connected,
// missing name) can be retried or dismissed, and CEO/SM can scan history.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { CampsNav } from '../CampsNav'
import { PurchasesWorkspace } from './PurchasesWorkspace'

export const dynamic = 'force-dynamic'

const ACT_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'])
const SCAN_ROLES = new Set(['ceo', 'senior_manager'])

export default async function CampPurchasesPage() {
  const me = await getCurrentUser()
  const canAct = Boolean(me && ACT_ROLES.has(me.role))
  const canScan = Boolean(me && SCAN_ROLES.has(me.role))

  return (
    <>
      <PageHeader
        title="Stripe purchases"
        subtitle="Payments labelled “summer camp” or “work experience” on Stripe, picked up automatically and entered into the Summer Camp app as bookings — with a review tray for anything that needs a human."
      />
      <PageBody>
        <CampsNav />
        <PurchasesWorkspace canAct={canAct} canScan={canScan} />
      </PageBody>
    </>
  )
}
