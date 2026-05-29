// Settings → Companies (CEO + Senior Manager). The list here is the source
// of truth for the company chips on contacts, the contacts-list filter, and
// every selector across the app. CLAUDE.md §4, §20.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { CompaniesAdmin } from './CompaniesAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Companies', href: '/settings/companies' },
]

export default async function CompaniesSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Companies" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to CEO and Senior Manager.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Companies"
        subtitle="Add, rename, recolour, or archive sister brands. Every selector and filter across the site reads from this list."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <CompaniesAdmin />
      </PageBody>
    </>
  )
}
