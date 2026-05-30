// Settings → Email accounts (Communications Hub, ADR 0021 Phase 1).
//
// All staff can see their own connected mailboxes and import their Gmail.
// Manager+ additionally creates shared team inboxes (info@, admissions@, …)
// and manages who can access them. CLAUDE.md §14, §20.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { MailAccountsAdmin } from './MailAccountsAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Email accounts', href: '/settings/email-accounts' },
]

export default async function EmailAccountsSettingsPage() {
  const me = await getCurrentUser()
  if (!me) {
    return (
      <>
        <PageHeader title="Email accounts" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">Sign in to manage mail accounts.</p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Email accounts"
        subtitle="Connect personal mailboxes and shared team inboxes — the foundation of the Communications Hub"
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <MailAccountsAdmin canManage={MANAGE_ROLES.has(me.role)} meId={me.id} />
      </PageBody>
    </>
  )
}
