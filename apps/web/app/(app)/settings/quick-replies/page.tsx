// Settings → Quick replies (Manager+). Catalogue of canned responses agents
// insert into a conversation reply. ADR 0020 Phase 6h. CLAUDE.md §20.1.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { QuickRepliesAdmin } from './QuickRepliesAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Quick replies', href: '/settings/quick-replies' },
]

export default async function QuickRepliesSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Quick replies" breadcrumbs={BREADCRUMBS} />
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
        title="Quick replies"
        subtitle="Canned responses agents insert into a conversation reply. Use {{first_name}} or {{name}} to personalise."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <QuickRepliesAdmin />
      </PageBody>
    </>
  )
}
