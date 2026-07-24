// Settings → Direct Debit recovery templates (Manager+). Staff-authored
// reminder / legal-escalation copy used to draft human-confirmed sends from a
// Direct Debit recovery case (ADR 0038, Phase 3). We ship no copy — bodies
// start empty. CLAUDE.md §20.1, §3.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { DdRecoveryTemplatesAdmin } from './DdRecoveryTemplatesAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Direct Debit recovery', href: '/settings/dd-recovery-templates' },
]

export default async function DdRecoveryTemplatesSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Direct Debit recovery templates" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">Restricted to Manager and above.</p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Direct Debit recovery"
        subtitle="The escalating email + text sequence used to chase an unpaid Direct Debit, and the settings behind it (late fee, cadence, response window, letterhead). The court fee and 8% statutory interest are calculated automatically per person. Everything here is customisable."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <DdRecoveryTemplatesAdmin />
      </PageBody>
    </>
  )
}
