// Settings → Forwarding (Manager+). Catalogue of "Forward to <team>" rules
// used from the contact page quick action. CLAUDE.md §20.1.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { ForwardingAdmin } from './ForwardingAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Forwarding', href: '/settings/forwarding' },
]

export default async function ForwardingSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Forwarding" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to Manager and above.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Forwarding"
        subtitle="Configurable “Forward to <team>” quick actions on the contact page. Edit recipients and templates as the team evolves."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <ForwardingAdmin />
      </PageBody>
    </>
  )
}
