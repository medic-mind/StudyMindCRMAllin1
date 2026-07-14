// Summer Camp bookings workspace — the CRM manager's per-booking surface.
// Rows come LIVE from the camp app's booking feed (the camp owns bookings);
// edits (status / subject / notes), camp assignment and new notes write back
// to the camp app and are audited here. CLAUDE.md §26 (RSC shell + client island).

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { BookingsWorkspace } from './BookingsWorkspace'

export const dynamic = 'force-dynamic'

const WRITE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])
const CANCEL_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

export default async function CampBookingsPage() {
  const me = await getCurrentUser()
  const canEdit = Boolean(me && WRITE_ROLES.has(me.role))
  const canCancel = Boolean(me && CANCEL_ROLES.has(me.role))

  return (
    <>
      <PageHeader
        title="Camp bookings"
        subtitle="Every Summer Camp booking, live from the camp app. Edit customer details, change status or subject, assign camps, and add notes — changes sync back to the camp site instantly."
      />
      <PageBody>
        <BookingsWorkspace canEdit={canEdit} canCancel={canCancel} />
      </PageBody>
    </>
  )
}
