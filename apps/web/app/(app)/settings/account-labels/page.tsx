// Settings → Account labels (Manager+). The shared, colour-coded label
// catalogue applied to B2B accounts (schools + B2B partners). CLAUDE.md §20.1.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { AccountLabelsAdmin } from './AccountLabelsAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Account labels', href: '/settings/account-labels' },
]

export default async function AccountLabelsSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Account labels" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">Restricted to Manager and above.</p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Account labels"
        subtitle="Custom, colour-coded labels for schools and B2B partners. Apply them in bulk from the Accounts list."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <AccountLabelsAdmin />
      </PageBody>
    </>
  )
}
