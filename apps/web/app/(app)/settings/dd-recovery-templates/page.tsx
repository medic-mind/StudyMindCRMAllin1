// Settings → Direct Debit recovery templates (Manager+). Staff-authored
// reminder / legal-escalation copy used to draft human-confirmed sends from a
// Direct Debit recovery case (ADR 0038, Phase 3). We ship no copy — bodies
// start empty. CLAUDE.md §20.1, §3.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { DdRecoveryTemplatesAdmin } from './DdRecoveryTemplatesAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Direct Debit recovery templates', href: '/settings/dd-recovery-templates' },
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
        title="Direct Debit recovery templates"
        subtitle="Reminder and legal-escalation copy for chasing a cancelled/underpaid plan. Nothing sends from here — these are drafted, reviewed and sent by a person from a recovery case. Tokens: {{first_name}} {{full_name}} {{customer_name}} {{plan_name}} {{amount_due}} {{collected}} {{plan_total}}."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <DdRecoveryTemplatesAdmin />
      </PageBody>
    </>
  )
}
